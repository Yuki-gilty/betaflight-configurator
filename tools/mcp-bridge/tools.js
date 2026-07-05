import { z } from "zod";

const axisShape = z
    .object({
        P: z.number().int().min(0).max(255).optional(),
        I: z.number().int().min(0).max(255).optional(),
        D: z.number().int().min(0).max(255).optional(),
        FF: z.number().int().min(0).max(2000).optional(),
    })
    .strict();

export function registerTools(server, relay) {
    const forward = (method) => async (params) => {
        try {
            const result = await relay.call(method, params ?? {});
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { isError: true, content: [{ type: "text", text: error?.message ?? String(error) }] };
        }
    };

    server.registerTool(
        "get_status",
        {
            description:
                "Get Configurator/FC connection state, firmware version, craft name and the currently active tab.",
        },
        forward("get_status"),
    );

    server.registerTool(
        "list_tabs",
        { description: "List the tab keys that can be passed to switch_tab." },
        forward("list_tabs"),
    );

    server.registerTool(
        "switch_tab",
        {
            description: "Switch the Configurator UI to the given tab (e.g. 'setup', 'pid_tuning', 'receiver').",
            inputSchema: { tab: z.string() },
        },
        forward("switch_tab"),
    );

    server.registerTool(
        "get_pid_tuning",
        { description: "Read current PID values (P/I/D/FF per roll/pitch/yaw axis) from the flight controller." },
        forward("get_pid_tuning"),
    );

    server.registerTool(
        "set_pid_tuning",
        {
            description:
                "Set PID values on the flight controller (RAM only until save_to_flash). " +
                "Pass only the axes/terms you want to change, e.g. { roll: { P: 47 } }.",
            inputSchema: {
                roll: axisShape.optional(),
                pitch: axisShape.optional(),
                yaw: axisShape.optional(),
            },
        },
        forward("set_pid_tuning"),
    );

    server.registerTool(
        "get_rates",
        { description: "Read current rate settings (RC rate, expo, super rate, throttle curve...)." },
        forward("get_rates"),
    );

    server.registerTool(
        "set_rates",
        {
            description:
                "Set rate parameters (RAM only until save_to_flash). Pass only the keys to change, " +
                "e.g. { values: { roll_rate: 0.8 } }. Call get_rates first to see valid keys.",
            inputSchema: { values: z.record(z.string(), z.number()) },
        },
        forward("set_rates"),
    );

    server.registerTool(
        "get_filters",
        { description: "Read current gyro / D-term filter settings." },
        forward("get_filters"),
    );

    server.registerTool(
        "set_filters",
        {
            description:
                "Set filter parameters (RAM only until save_to_flash). Pass only the keys to change, " +
                "e.g. { values: { gyro_lowpass_hz: 100 } }. Call get_filters first to see valid keys.",
            inputSchema: { values: z.record(z.string(), z.number()) },
        },
        forward("set_filters"),
    );

    server.registerTool(
        "save_to_flash",
        {
            description:
                "DESTRUCTIVE: write current settings to the flight controller's flash (MSP_EEPROM_WRITE). " +
                "Until this is called, set_* changes live in RAM and are lost on power cycle. " +
                "Confirm with the user before calling.",
        },
        forward("save_to_flash"),
    );

    server.registerTool(
        "msp_command",
        {
            description:
                "ADVANCED / low-level escape hatch: send a raw MSP command. `code` is the MSP command id, " +
                "`data` is an optional byte array payload. Can change or break FC state - use only when no " +
                "dedicated tool exists, and confirm with the user first.",
            inputSchema: {
                code: z.number().int().min(0).max(65535),
                data: z.array(z.number().int().min(0).max(255)).optional(),
            },
        },
        forward("msp_command"),
    );
}
