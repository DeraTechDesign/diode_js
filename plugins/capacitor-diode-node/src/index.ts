import { registerPlugin } from '@capacitor/core';
import type { DiodeNodePlugin } from './definitions';

const loadHybrid = () => import('./web').then(m => new m.DiodeNodeWeb());

const DiodeNode = registerPlugin<DiodeNodePlugin>('DiodeNode', {
  web: () => loadHybrid(),
  ios: () => loadHybrid(),
  android: () => loadHybrid(),
});

export * from './definitions';
export { DiodeNode };
