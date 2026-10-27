import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {russian, resolveLanguage, configureLanguage, t, errorText} from '../i18n.js';

test('system UI language selects Russian with explicit overrides and English fallback',()=>{
  for(const locale of ['ru','ru-RU','RU_ru','ru-BY'])assert.equal(resolveLanguage('System',locale),'ru');
  for(const locale of ['en-US','pl-PL','uk-UA','','russian'])assert.equal(resolveLanguage('System',locale),'en');
  assert.equal(resolveLanguage('English','ru-RU'),'en');
  assert.equal(resolveLanguage('Russian','en-US'),'ru');
});

test('all translations retain exactly the same interpolation variables and unique keys',async()=>{
  const source=await readFile(new URL('../i18n.js',import.meta.url),'utf8');
  const keys=[...source.matchAll(/^  '([^']+)':/gm)].map(match=>match[1]);
  assert.equal(new Set(keys).size,keys.length);
  const variables=text=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
  for(const [key,value] of Object.entries(russian)){
    assert.ok(value.trim(),key);assert.deepEqual(variables(value),variables(key),key);
  }
});

test('localized errors preserve source paths and diagnostic details',()=>{
  configureLanguage('Russian');
  assert.equal(t('Starting in {seconds}…',{seconds:3}),'Начало через 3…');
  assert.equal(errorText(new Error('Display disconnected')),'Экран отключён');
  const detail='C:/Videos/<draft>.mp4: access denied';
  assert.equal(errorText('Recording journal was not updated: '+detail),'Не удалось обновить журнал записи: '+detail);
  assert.equal(errorText(detail),detail);
  assert.equal(errorText('Could not assign shortcut. Another app may be using it. Previous shortcuts restored. '+detail),'Не удалось назначить сочетание. Возможно, оно занято другим приложением. Прежние сочетания восстановлены. '+detail);
  configureLanguage('English');
  assert.equal(t('Record'),'Record');
});
