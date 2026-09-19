import type { CancellationToken } from 'vscode';
import { DiscoveredModelInfo, ModelDiscovery } from './types';

/**
 * Chains backend probes so the catalog stays backend-agnostic: the first
 * probe that recognises the server and knows the model answers. Each probe
 * caches its own detection, so a foreign backend costs one cheap request per
 * probe per config generation.
 */
export class CompositeDiscovery implements ModelDiscovery {
  constructor(private readonly probes: readonly ModelDiscovery[]) {}

  public reset(): void {
    for (const probe of this.probes) {
      probe.reset();
    }
  }

  public async enrichModel(
    modelId: string,
    token?: CancellationToken
  ): Promise<DiscoveredModelInfo | undefined> {
    for (const probe of this.probes) {
      const info = await probe.enrichModel(modelId, token);
      if (info) {
        return info;
      }
      if (token?.isCancellationRequested) {
        return undefined;
      }
    }
    return undefined;
  }
}
