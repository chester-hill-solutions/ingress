import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Called only after explicit --real admission; secret values never enter evidence. */
export async function selectedProfile() {
  const home = homedir();
  const selection = JSON.parse(await readFile(join(home, '.local/state/opencode/model.json'), 'utf8'));
  const selected = selection.recent?.find(value => value.providerID === 'opencode');
  if (!selected?.modelID) throw new Error('Select an OpenCode provider model before the real probe');
  let apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    const login = JSON.parse(await readFile(join(home, '.local/share/opencode/auth.json'), 'utf8'));
    if (login.opencode?.type !== 'api' || !login.opencode.key) throw new Error('Existing OpenCode API login unavailable');
    apiKey = login.opencode.key;
  }
  let modelCatalogPath = join(home, '.cache/opencode/models.json');
  try { await access(modelCatalogPath); } catch { modelCatalogPath = undefined; }
  return { binary: join(home, '.opencode/bin/opencode'), model: { providerID: 'opencode', id: selected.modelID },
    apiKey, baseURL: 'https://opencode.ai/zen/v1', modelCatalogPath };
}
