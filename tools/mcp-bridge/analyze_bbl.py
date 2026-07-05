#!/usr/bin/env python3
"""Analyze a Betaflight blackbox log for PID tuning.

Usage:
    python3 analyze_bbl.py <log.bbl | log.csv> [--json OUT.json]
    python3 analyze_bbl.py --selftest

.bbl files are decoded with the `blackbox_decode` binary
(https://github.com/betaflight/blackbox-tools - clone and `make`, or pass a
pre-decoded CSV). Outputs a JSON summary designed to be read by an LLM:
per-axis step response metrics (with a downsampled trace), gyro noise
spectrum summaries, and motor saturation statistics.

Requires: numpy, scipy  (pip install numpy scipy)
"""

import argparse
import csv
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy import signal

AXES = ["roll", "pitch", "yaw"]
RESPONSE_SECONDS = 0.5  # length of computed step response
WINDOW_SECONDS = 2.0  # deconvolution window
MIN_SETPOINT_ACTIVITY = 20.0  # deg/s of setpoint movement for a window to count


def decode_bbl(bbl_path: Path) -> Path:
    """Decode a .bbl to CSV using blackbox_decode. Returns the CSV path."""
    exe = shutil.which("blackbox_decode")
    if not exe:
        sys.exit(
            "ERROR: blackbox_decode not found on PATH.\n"
            "Install it with:\n"
            "  git clone https://github.com/betaflight/blackbox-tools\n"
            "  cd blackbox-tools && make && sudo cp obj/blackbox_decode /usr/local/bin/\n"
            "Or decode manually and pass the CSV instead of the .bbl."
        )
    outdir = Path(tempfile.mkdtemp(prefix="bbl_"))
    work = outdir / bbl_path.name
    work.write_bytes(bbl_path.read_bytes())
    subprocess.run([exe, str(work)], check=True, capture_output=True)
    csvs = sorted(outdir.glob("*.csv"))
    csvs = [c for c in csvs if not c.name.endswith(".gps.csv") and not c.name.endswith(".event.csv")]
    if not csvs:
        sys.exit("ERROR: blackbox_decode produced no CSV (is the log corrupt?)")
    # A .bbl can contain several flight sessions; analyze the largest one.
    return max(csvs, key=lambda c: c.stat().st_size)


def load_csv(csv_path: Path) -> dict:
    """Load the decoder CSV into numpy arrays keyed by normalized column name."""
    with open(csv_path, newline="") as fh:
        reader = csv.reader(fh)
        header = [h.strip().split(" (")[0] for h in next(reader)]
        rows = [row for row in reader if len(row) == len(header)]
    if len(rows) < 1000:
        sys.exit(f"ERROR: log too short ({len(rows)} frames) for meaningful analysis.")
    data = {}
    columns = list(zip(*rows))
    for name, column in zip(header, columns):
        try:
            data[name] = np.asarray(column, dtype=float)
        except ValueError:
            pass  # non-numeric column (flight mode flags etc.)
    return data


def uniform_resample(time_us, series):
    """Resample onto a uniform grid (logs can have dropped frames)."""
    t = (time_us - time_us[0]) / 1e6
    dt = float(np.median(np.diff(t)))
    grid = np.arange(0.0, t[-1], dt)
    return dt, [np.interp(grid, t, s) for s in series]


def step_response(setpoint, gyro, dt):
    """PID-Analyzer style Wiener deconvolution, averaged over active windows."""
    win = int(WINDOW_SECONDS / dt)
    resp_len = int(RESPONSE_SECONDS / dt)
    if len(setpoint) < win * 2:
        return None
    hann = np.hanning(win)
    responses, weights = [], []
    for start in range(0, len(setpoint) - win, win // 2):
        sp = setpoint[start : start + win]
        gy = gyro[start : start + win]
        activity = float(np.std(sp))
        if activity < MIN_SETPOINT_ACTIVITY:
            continue
        sp_f = np.fft.rfft(sp * hann)
        gy_f = np.fft.rfft(gy * hann)
        gain = np.abs(sp_f) ** 2
        wiener = np.conj(sp_f) * gy_f / (gain + 0.0001 * float(np.max(gain)))
        impulse = np.fft.irfft(wiener)[:resp_len]
        responses.append(np.cumsum(impulse))
        weights.append(activity)
    if not responses:
        return None
    resp = np.average(np.asarray(responses), axis=0, weights=np.asarray(weights))
    t = np.arange(resp_len) * dt

    steady = float(np.mean(resp[int(0.2 / dt) :]))
    if abs(steady) < 1e-6:
        return None
    norm = resp / steady
    peak_idx = int(np.argmax(norm))
    above10 = np.nonzero(norm >= 0.1)[0]
    above90 = np.nonzero(norm >= 0.9)[0]
    rise_ms = float((above90[0] - above10[0]) * dt * 1e3) if len(above10) and len(above90) else None
    settled = np.nonzero(np.abs(norm - 1.0) > 0.05)[0]
    settling_ms = float((settled[-1] + 1) * dt * 1e3) if len(settled) else 0.0

    step = max(1, resp_len // 100)
    return {
        "windows_used": len(responses),
        "peak": round(float(norm[peak_idx]), 3),
        "overshoot_pct": round((float(norm[peak_idx]) - 1.0) * 100, 1),
        "time_to_peak_ms": round(peak_idx * dt * 1e3, 1),
        "rise_time_ms": round(rise_ms, 1) if rise_ms is not None else None,
        "settling_time_ms": round(settling_ms, 1),
        "trace_ms": [round(float(x) * 1e3, 2) for x in t[::step]],
        "trace": [round(float(x), 3) for x in norm[::step]],
    }


def noise_summary(series, dt):
    freqs, psd = signal.welch(series - np.mean(series), fs=1.0 / dt, nperseg=min(4096, len(series)))
    bands = {"0-80Hz": (0, 80), "80-200Hz": (80, 200), "200-500Hz": (200, 500)}
    out = {}
    for label, (lo, hi) in bands.items():
        mask = (freqs >= lo) & (freqs < hi)
        if mask.any():
            out[label + "_rms"] = round(float(np.sqrt(np.trapezoid(psd[mask], freqs[mask]))), 2)
    peak_region = freqs > 30
    if peak_region.any():
        peak_i = int(np.argmax(psd[peak_region]))
        out["dominant_peak_hz"] = round(float(freqs[peak_region][peak_i]), 1)
    return out


def analyze(data):
    names = [f"gyroADC[{i}]" for i in range(3)]
    if not all(n in data for n in names) or "time" not in data:
        sys.exit(f"ERROR: CSV is missing gyro/time columns. Found: {sorted(data)[:20]}...")
    sp_names = [f"setpoint[{i}]" for i in range(3)]
    if not all(n in data for n in sp_names):
        sys.exit("ERROR: log has no setpoint[] fields - enable them in blackbox settings (BF 3.3+ default).")

    series = [data[n] for n in names] + [data[n] for n in sp_names]
    dt, resampled = uniform_resample(data["time"], series)
    gyros, setpoints = resampled[:3], resampled[3:]

    axes = {}
    for i, axis in enumerate(AXES):
        axes[axis] = {
            "step_response": step_response(setpoints[i], gyros[i], dt),
            "gyro_noise": noise_summary(gyros[i], dt),
        }

    result = {"sample_rate_hz": round(1.0 / dt), "duration_s": round(len(gyros[0]) * dt, 1), "axes": axes}

    motor_cols = sorted(n for n in data if n.startswith("motor["))
    if motor_cols:
        motors = np.asarray([data[m] for m in motor_cols])
        mmax = float(np.max(motors))
        result["motors"] = {
            "mean_pct": round(float(np.mean(motors)) / mmax * 100, 1) if mmax else None,
            "saturated_pct": round(float(np.mean(np.any(motors >= mmax * 0.99, axis=0))) * 100, 2),
        }
    return result


def read_bbl_header(bbl_path):
    """The .bbl header is plain text and contains the full FC configuration."""
    header = {}
    with open(bbl_path, "rb") as fh:
        for raw in fh:
            if not raw.startswith(b"H "):
                break
            line = raw[2:].decode("ascii", "replace").strip()
            if ":" in line:
                key, value = line.split(":", 1)
                header[key] = value
    keep = [k for k in header if any(s in k.lower() for s in ("pid", "rate", "filter", "lpf", "notch", "firmware"))]
    return {k: header[k] for k in keep}


def selftest():
    """Verify step-response recovery on a synthetic second-order system."""
    rng = np.random.default_rng(0)
    dt = 1.0 / 2000
    n = 2000 * 60
    # low-pass filtered white noise as stick input; amplitude chosen so the
    # windowed std clears MIN_SETPOINT_ACTIVITY
    setpoint = signal.lfilter(*signal.butter(2, 4, fs=1 / dt), rng.normal(0, 2000, n))
    wn, zeta = 2 * np.pi * 20, 0.6  # 20 Hz, expected overshoot ~9.5%
    system = signal.cont2discrete(([wn**2], [1, 2 * zeta * wn, wn**2]), dt)
    gyro = signal.lfilter(np.squeeze(system[0]), np.squeeze(system[1]), setpoint) + rng.normal(0, 5, n)
    result = step_response(setpoint, gyro, dt)
    expected = math.exp(-zeta * math.pi / math.sqrt(1 - zeta**2)) * 100
    assert result is not None, "no response computed"
    assert abs(result["peak"] - 1 - expected / 100) < 0.05, f"overshoot mismatch: {result}"
    assert abs(np.mean(result["trace"][-20:]) - 1.0) < 0.05, f"steady state mismatch: {result}"
    print(
        f"SELFTEST OK: overshoot={result['overshoot_pct']}% (expected ~{expected:.1f}%), "
        f"rise={result['rise_time_ms']}ms"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", nargs="?", help=".bbl or decoded .csv file")
    parser.add_argument("--json", help="write JSON result to this path (default: stdout)")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        selftest()
        return
    if not args.log:
        parser.error("log file required (or --selftest)")

    log = Path(args.log)
    result = {}
    if log.suffix.lower() == ".csv":
        csv_path = log
    else:
        result["header"] = read_bbl_header(log)
        csv_path = decode_bbl(log)
    result.update(analyze(load_csv(csv_path)))

    output = json.dumps(result, indent=1)
    if args.json:
        Path(args.json).write_text(output)
        print(f"written: {args.json}")
    else:
        print(output)


if __name__ == "__main__":
    main()
