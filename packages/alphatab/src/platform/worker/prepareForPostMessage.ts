/**
 * Unwrap framework proxy values without loading renderer configuration.
 * @internal
 * @target web
 */
export function prepareForPostMessage<T>(object: T): T {
    if (!object) {
        return object;
    }

    // Vue toRaw:
    // https://github.com/vuejs/core/blob/e7381761cc7971c0d40ae0a0a72687a500fd8db3/packages/reactivity/src/reactive.ts#L378-L381

    if (typeof object === 'object') {
        const unwrapped = (object as any).__v_raw;
        if (unwrapped) {
            return prepareForPostMessage(unwrapped);
        }
    }

    // Solidjs unwrap: the symbol required to access the raw object is unfortunately hidden and we cannot unwrap it without importing
    // import { unwrap } from "solid-js/store"
    // alternative for users is to replace this method during runtime.

    return object;
}
