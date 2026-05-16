# GPU Passthrough for Container Agents

## Overview

Enable NanoClaw container agents to access the host GPU via NVIDIA Container Toolkit. GPU access is configured per-group through `ContainerConfig.gpu`, detected at startup, and passed as `--gpus all` to Docker.

## Context

- Host: Quadro RTX 5000 (16GB), driver 580.126.09
- NVIDIA Container Toolkit 2.0+ installed and working
- Use cases: ML training/inference (PyTorch, iTransformer), local LLM inference (Ollama, vLLM)
- Single GPU shared across all GPU-enabled groups

## Design

### Approach: `--gpus all` flag injection (Approach A)

Keep the existing `node:22-slim` base image unchanged. The NVIDIA Container Toolkit injects GPU drivers and CUDA libraries into containers at runtime when `--gpus` is specified. Agents install ML frameworks (PyTorch, etc.) on demand and can cache them in the persistent group directory.

### Changes

#### 1. `src/types.ts` — Add `gpu` field

```typescript
interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  gpu?: boolean;  // Pass --gpus all to container
}
```

Boolean only. Single-GPU scenario does not need device selection. Limitation: if multiple GPUs are added in the future, `--gpus all` exposes all of them. Migration path: change `gpu` to `boolean | string` where string is a device ID.

#### 2. `src/container-runtime.ts` — GPU detection

Add `isGpuAvailable()`: runs `nvidia-smi` once, caches result for process lifetime. Uses `execSync` to match existing code style in this file.

```typescript
let gpuAvailable: boolean | null = null;

export function isGpuAvailable(): boolean {
  if (gpuAvailable !== null) return gpuAvailable;
  try {
    execSync('nvidia-smi --query-gpu=name --format=csv,noheader',
      { timeout: 5000, stdio: 'pipe' });
    gpuAvailable = true;
  } catch {
    gpuAvailable = false;
  }
  return gpuAvailable;
}
```

Cache is not invalidated. If GPU config changes (driver update, GPU reset), restart the NanoClaw service.

#### 3. `src/container-runner.ts` — Inject GPU flags

**Signature change required:** Extend `buildContainerArgs(mounts, containerName)` to accept a third parameter `containerConfig?: ContainerConfig`. Update the call site in `runContainerAgent` to pass `group.containerConfig`.

Insert GPU flags immediately before `args.push(CONTAINER_IMAGE)` (the last line before return):

```typescript
// GPU passthrough
if (containerConfig?.gpu && isGpuAvailable()) {
  args.push('--gpus', 'all');
  args.push('-e', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility');
} else if (containerConfig?.gpu) {
  logger.warn({ groupFolder }, 'GPU requested but not available');
}

args.push(CONTAINER_IMAGE);
```

The `NVIDIA_DRIVER_CAPABILITIES=compute,utility` env var ensures CUDA compute is available inside the container (the toolkit default only exposes utility capabilities).

#### 4. No Dockerfile changes

The existing `node:22-slim` image works with `--gpus all` because NVIDIA Container Toolkit mounts the driver and CUDA libraries into the container at runtime. Agents can `pip install torch` etc. as needed.

#### 5. No database migration

`containerConfig` is stored as JSON in SQLite. Adding `gpu` field is backward-compatible. Existing groups without `gpu` default to no GPU access.

### Error Handling

- `nvidia-smi` check timeout: 5 seconds. Failure = GPU unavailable.
- GPU unavailable when requested: warn log, container starts without GPU. No crash.
- Cached detection: checked once per process lifetime. If GPU becomes unavailable after startup, Docker will report the error at container creation time.

### Limitations

- **No GPU memory isolation:** Docker's `--gpus` does not provide VRAM isolation. If multiple GPU-enabled containers run simultaneously, they share the 16GB VRAM. OOM is possible. Mitigation: `MAX_CONCURRENT_CONTAINERS` limits concurrent containers (default 5).
- **No hot-plug detection:** GPU availability is cached at startup. Restart service after GPU configuration changes.
- **Single GPU only:** `--gpus all` exposes all GPUs. Future multi-GPU support would require per-group device assignment.

### Activation

After implementation, update the main group's containerConfig:

```typescript
setRegisteredGroup('oc_...@feishu', {
  ...existingGroup,
  containerConfig: { ...existingConfig, gpu: true }
});
```

## Testing

Tests follow existing patterns — GPU flag injection is tested through `runContainerAgent` (the public API), matching the existing test style in `container-runner.test.ts`. GPU detection is tested directly since `isGpuAvailable` is exported.

| Test | What it verifies |
|------|-----------------|
| `isGpuAvailable()` returns true when `nvidia-smi` succeeds | Detection happy path |
| `isGpuAvailable()` returns false when `nvidia-smi` fails | Detection failure path |
| `isGpuAvailable()` caches result | No repeated exec calls |
| Container args include `--gpus all` when `gpu: true` + available | Flag injection |
| Container args omit `--gpus` when `gpu: true` + unavailable | Graceful degradation |
| Container args omit `--gpus` when `gpu` not set | Default behavior unchanged |
| Existing tests pass unchanged | No regression |

## Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `gpu?: boolean` to `ContainerConfig` |
| `src/container-runtime.ts` | Add `isGpuAvailable()` |
| `src/container-runner.ts` | Extend `buildContainerArgs` signature, inject `--gpus all` + `NVIDIA_DRIVER_CAPABILITIES` |
| `src/container-runtime.test.ts` | Tests for GPU detection |
| `src/container-runner.test.ts` | Tests for GPU flag injection |
