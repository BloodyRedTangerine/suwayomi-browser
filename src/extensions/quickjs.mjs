import { newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';
import release from '@jitl/quickjs-wasmfile-release-sync';

let modulePromise;
const contexts = new Map();
export async function evaluateScript(request) {
  modulePromise ||= newQuickJSWASMModuleFromVariant(newVariant(release, {
    wasmLocation: new URL('./quickjs.wasm', import.meta.url).href,
  }));
  const module = await modulePromise;
  if (request.action === 'close') {
    contexts.get(request.context)?.dispose();
    contexts.delete(request.context);
    return { value: null };
  }
  let context = contexts.get(request.context);
  if (!context) {
    context = module.newContext();
    context.runtime.setMemoryLimit(64 * 1024 * 1024);
    contexts.set(request.context, context);
  }
  context.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 15_000));
  const result = context.evalCode(request.script, 'extension.js');
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    return { error: error.message || String(error) };
  }
  const value = context.dump(result.value);
  result.value.dispose();
  return typeof value === 'bigint' ? { value: String(value), type: 'bigint' } : { value: value === undefined ? null : value };
}
