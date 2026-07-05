import FC from "../fc.js";
import MSP from "../msp.js";
import MSPCodes from "../msp/MSPCodes.js";
import { mspHelper } from "../msp/MSPHelper.js";
import CONFIGURATOR from "../data_storage.js";
import GUI from "../gui.js";
import { switchTab } from "../tab_switch.js";
import { sidebarItems } from "../../components/sidebar/sidebar_items.js";

const AXES = [
    ["roll", 0, "feedforwardRoll"],
    ["pitch", 1, "feedforwardPitch"],
    ["yaw", 2, "feedforwardYaw"],
];
const PID_TERMS = [
    ["P", 0],
    ["I", 1],
    ["D", 2],
];

function requireFc() {
    if (!CONFIGURATOR.connectionValid) {
        throw new Error("FC not connected. Ask the user to connect the flight controller in the Configurator first.");
    }
}

function pidSnapshot() {
    const result = {};
    for (const [axis, index, ffKey] of AXES) {
        result[axis] = {
            P: FC.PIDS[index][0],
            I: FC.PIDS[index][1],
            D: FC.PIDS[index][2],
            FF: FC.ADVANCED_TUNING[ffKey],
        };
    }
    return result;
}

async function refreshPids() {
    await MSP.promise(MSPCodes.MSP_PID, false);
    await MSP.promise(MSPCodes.MSP_PID_ADVANCED, false);
}

// Shared read-modify-write cycle for flat numeric sections (rates, filters).
async function updateSection({ readCode, writeCode, getTarget, values }) {
    requireFc();
    await MSP.promise(readCode, false);
    const target = getTarget();
    const unknown = Object.keys(values ?? {}).filter((key) => !(key in target));
    if (unknown.length > 0) {
        throw new Error(
            `Unknown parameter(s): ${unknown.join(", ")}. Valid parameters: ${Object.keys(target).join(", ")}`,
        );
    }
    Object.assign(target, values);
    await MSP.promise(writeCode, mspHelper.crunch(writeCode));
    await MSP.promise(readCode, false);
    return { ...getTarget() };
}

export function createHandlers() {
    return {
        async get_status() {
            const { flightControllerIdentifier, flightControllerVersion, apiVersion, craftName, name } = FC.CONFIG;
            return {
                fcConnected: CONFIGURATOR.connectionValid,
                firmware: flightControllerIdentifier
                    ? `${flightControllerIdentifier} ${flightControllerVersion}`
                    : null,
                apiVersion: apiVersion ?? null,
                craftName: craftName || name || null,
                activeTab: GUI.active_tab || null,
            };
        },

        async list_tabs() {
            return { tabs: sidebarItems.map((item) => item.tab ?? item.key).filter(Boolean) };
        },

        async switch_tab({ tab }) {
            const mode = CONFIGURATOR.connectionValid ? "connected" : "disconnected";
            const refused = switchTab(tab, { mode }) === false;
            if (refused) {
                throw new Error(
                    `Could not switch to tab '${tab}' (tab is locked, already active, or not allowed right now).`,
                );
            }
            return { activeTab: tab };
        },

        async get_pid_tuning() {
            requireFc();
            await refreshPids();
            return pidSnapshot();
        },

        async set_pid_tuning(params) {
            requireFc();
            await refreshPids();
            for (const [axis, index, ffKey] of AXES) {
                const changes = params?.[axis];
                if (!changes) {
                    continue;
                }
                for (const [term, termIndex] of PID_TERMS) {
                    if (changes[term] !== undefined) {
                        FC.PIDS[index][termIndex] = changes[term];
                    }
                }
                if (changes.FF !== undefined) {
                    FC.ADVANCED_TUNING[ffKey] = changes.FF;
                }
            }
            await MSP.promise(MSPCodes.MSP_SET_PID, mspHelper.crunch(MSPCodes.MSP_SET_PID));
            await MSP.promise(MSPCodes.MSP_SET_PID_ADVANCED, mspHelper.crunch(MSPCodes.MSP_SET_PID_ADVANCED));
            await refreshPids();
            return pidSnapshot();
        },

        async get_rates() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_RC_TUNING, false);
            return { ...FC.RC_TUNING };
        },

        async set_rates({ values } = {}) {
            return updateSection({
                readCode: MSPCodes.MSP_RC_TUNING,
                writeCode: MSPCodes.MSP_SET_RC_TUNING,
                getTarget: () => FC.RC_TUNING,
                values,
            });
        },

        async get_filters() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_FILTER_CONFIG, false);
            return { ...FC.FILTER_CONFIG };
        },

        async set_filters({ values } = {}) {
            return updateSection({
                readCode: MSPCodes.MSP_FILTER_CONFIG,
                writeCode: MSPCodes.MSP_SET_FILTER_CONFIG,
                getTarget: () => FC.FILTER_CONFIG,
                values,
            });
        },

        async save_to_flash() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_EEPROM_WRITE, false);
            return { saved: true };
        },

        async get_blackbox_info() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_DATAFLASH_SUMMARY, false);
            return { ...FC.DATAFLASH };
        },

        async read_dataflash_chunk({ address, size } = {}) {
            requireFc();
            const dataView = await new Promise((resolve, reject) => {
                mspHelper.dataflashRead(address, size ?? 4096, (chunkAddress, chunk) => {
                    if (chunk === null) {
                        reject(new Error(`Dataflash read failed at address ${address}`));
                    } else {
                        resolve(chunk);
                    }
                });
            });
            const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return { address, bytes: bytes.length, base64: btoa(binary) };
        },

        async erase_blackbox() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_DATAFLASH_ERASE, false);
            return { erased: true };
        },

        async msp_command({ code, data } = {}) {
            requireFc();
            const payload = Array.isArray(data) && data.length > 0 ? Uint8Array.from(data) : false;
            const response = await MSP.promise(code, payload);
            const view = response?.dataView;
            const bytes = view ? Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) : [];
            return { code, response: bytes };
        },
    };
}
