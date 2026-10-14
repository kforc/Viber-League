// render/webgl.ts — cheap, side-effect-free WebGL capability probe.
//
// Used once at boot, BEFORE any renderer is constructed, so a machine without
// WebGL gets a clear message instead of an uncaught exception and a blank page.
//
// We never create a real THREE.WebGLRenderer here — just ask a throwaway canvas
// for a context. Some browsers return null, some throw; both mean "no WebGL".

export function isWebGLAvailable(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    return Boolean(gl);
  } catch {
    return false;
  }
}
