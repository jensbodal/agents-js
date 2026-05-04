export interface BrowserCapabilities {
  webgpu: boolean;
  secureContext: boolean;
  adapterFeatures: string[];
  deviceMemoryGB: number;
}

const FALLBACK_DEVICE_MEMORY_GB = 8;

export async function detectBrowserCapabilities(): Promise<BrowserCapabilities> {
  const nav = (
    globalThis as unknown as {
      navigator?: {
        gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> };
        deviceMemory?: number;
      };
    }
  ).navigator;
  const secureContext = Boolean(
    (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext,
  );
  const deviceMemoryGB = nav?.deviceMemory ?? FALLBACK_DEVICE_MEMORY_GB;

  if (!secureContext || !nav?.gpu) {
    return { webgpu: false, secureContext, adapterFeatures: [], deviceMemoryGB };
  }

  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) {
      return { webgpu: false, secureContext, adapterFeatures: [], deviceMemoryGB };
    }
    return {
      webgpu: true,
      secureContext,
      adapterFeatures: [...adapter.features],
      deviceMemoryGB,
    };
  } catch {
    return { webgpu: false, secureContext, adapterFeatures: [], deviceMemoryGB };
  }
}
