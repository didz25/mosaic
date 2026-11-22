import { analyzeBass, type BassInput } from './bass';

self.onmessage = (e: MessageEvent<BassInput>) => {
  try {
    self.postMessage({ ok: true, result: analyzeBass(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
