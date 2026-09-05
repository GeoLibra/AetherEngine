import { exec } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const execAsync = promisify(exec);

/**
 * Automatically cooks built-in shaders (WGSL -> GLSL + Manifest) when WGSL sources are edited,
 * updating generated TypeScript artifacts and triggering seamless Vite HMR.
 */
function autoCookBuiltinShaderPlugin(): Plugin {
  return {
    name: 'auto-cook-builtin-shaders',
    configureServer(server) {
      const rootDir = resolve(__dirname, '../..');
      const shaderDir = resolve(rootDir, 'src/shader/builtins');

      // Watch the built-in shader directory
      server.watcher.add(shaderDir);

      let isCooking = false;
      let pendingCook = false;

      const triggerCook = async () => {
        if (isCooking) {
          pendingCook = true;
          return;
        }
        isCooking = true;
        server.config.logger.info('⚡ [shader] Detected WGSL source change, recompiling...', {
          timestamp: true
        });
        try {
          await execAsync('pnpm run shader:generate', { cwd: rootDir });
          server.config.logger.info('✓ [shader] Shader compilation succeeded, HMR triggered', {
            timestamp: true
          });
        } catch (err: unknown) {
          const errObj = err as { stdout?: string; stderr?: string; message?: string };
          const details = (
            errObj.stderr ||
            errObj.stdout ||
            errObj.message ||
            'Unknown error'
          ).trim();
          server.config.logger.error(`❌ [shader] Shader compilation failed:\n${details}`, {
            timestamp: true
          });
          // Dispatch full-screen error overlay to the browser
          server.ws.send({
            type: 'error',
            err: {
              message: `[shader] Naga compilation failed:\n\n${details}`,
              stack: ''
            }
          });
        } finally {
          isCooking = false;
          if (pendingCook) {
            pendingCook = false;
            void triggerCook();
          }
        }
      };

      server.watcher.on('change', (file) => {
        if (file.endsWith('.wgsl') || file.endsWith('.wgsl.meta.json')) {
          void triggerCook();
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), autoCookBuiltinShaderPlugin()],
  server: {
    fs: {
      allow: [resolve(__dirname, '../..')]
    }
  },
  resolve: {
    alias: {
      '@aether/engine': resolve(__dirname, '../../src/index.ts')
    }
  }
});
