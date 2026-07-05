/**
 * Pending-request bookkeeping between the MCP server and the Configurator
 * browser tab. Transport-agnostic: sockets only need send() and close().
 */
export class ConfiguratorRelay {
    constructor({ timeoutMs = 10000 } = {}) {
        this.socket = null;
        this.pending = new Map();
        this.nextId = 1;
        this.timeoutMs = timeoutMs;
    }

    attach(socket) {
        if (this.socket && this.socket !== socket) {
            try {
                this.socket.close();
            } catch {
                // previous socket may already be dead
            }
        }
        this.socket = socket;
    }

    detach(socket) {
        if (this.socket === socket) {
            this.socket = null;
        }
    }

    get connected() {
        return this.socket !== null;
    }

    call(method, params = {}) {
        if (!this.socket) {
            return Promise.reject(
                new Error(
                    "Configurator is not connected to the bridge. Start the app with `npm run dev` and open it in a browser.",
                ),
            );
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for Configurator response to '${method}'`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) {
            return;
        }
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error !== undefined) {
            entry.reject(new Error(message.error));
        } else {
            entry.resolve(message.result);
        }
    }
}
