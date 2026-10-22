import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRuntimeInventory } from '../scripts/runtime-inventory-guard.mjs';
const required = ['com/ibm/icu/text/BreakIterator.class', 'com/ibm/icu/text/Normalizer2.class',
  'com/ibm/icu/text/RuleBasedCollator.class', 'META-INF/services/sun.util.resources.LocaleData$CommonResourceBundleProvider'];
const valid = () => ({ runtimeFiles: ['jdk23/lib/modules'], hostEntries: [...required] });
test('single JIMAGE with ICU/layout and locale service passes', () => assert.doesNotThrow(() => assertRuntimeInventory(valid())));
test('empty framework directory records are harmless',()=>{const inventory=valid();inventory.hostEntries.push('res/','jni/','assets/');assert.doesNotThrow(()=>assertRuntimeInventory(inventory));});
test('a Java class in a package named res is not a framework asset',()=>{const inventory=valid();inventory.hostEntries.push('res/Helper.class');assert.doesNotThrow(()=>assertRuntimeInventory(inventory));});
test('duplicate JDK archive is refused', () => { const inventory=valid();inventory.runtimeFiles.push('jdk23.jar');assert.throws(()=>assertRuntimeInventory(inventory),/duplicate JDK/); });
test('missing JIMAGE is refused', () => assert.throws(()=>assertRuntimeInventory({...valid(),runtimeFiles:[]}),/module image missing/));
for (const name of ['res/drawable/fixture.png','resources.arsc','jni/test/libfixture.so','assets/fixture.bin'])
  test('unusable framework asset is refused: '+name,()=>{const inventory=valid();inventory.hostEntries.push(name);assert.throws(()=>assertRuntimeInventory(inventory),/framework asset/);});
test('missing locale service is refused',()=>{const inventory=valid();inventory.hostEntries.pop();assert.throws(()=>assertRuntimeInventory(inventory),/Required runtime entry/);});
