import path from 'path';
import os from 'os';
import fs from 'fs';

/** Read the repo registry to get all repo names — used for auto-granting repos to first admin */
export function listRegisteredRepos(): string[] {
  try {
    const registryPath = path.join(os.homedir(), '.gitnexus', 'registry.json');
    if (!fs.existsSync(registryPath)) return [];
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    if (Array.isArray(data)) return data.map((r: any) => r.name).filter(Boolean);
    return [];
  } catch {
    return [];
  }
}
