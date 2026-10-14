// Minimal JS replacement for the @Remote decorator, which is TypeScript-only.
// The gateway discovers remote methods by reading the
// "@deepseek-ai/dsh-typert-protocol/remote-methods" descriptor on the service
// prototype (see dsh-api-gateway collectSrcClaims); writing that descriptor
// directly is the documented marker shape {version:1, methods:[...]}.
const MARKER = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** Mark class methods as direct remote methods (equivalent to @Remote). */
export function remoteMethods(klass, names) {
    const proto = klass.prototype;
    const existing = Object.getOwnPropertyDescriptor(proto, MARKER)?.value;
    const prior = Array.isArray(existing?.methods) ? existing.methods : [];
    const added = names.map((method) => Object.freeze({ method, invocation: { kind: "direct" } }));
    Object.defineProperty(proto, MARKER, {
        configurable: true,
        value: Object.freeze({ version: 1, methods: Object.freeze([...prior, ...added]) }),
    });
    return klass;
}
