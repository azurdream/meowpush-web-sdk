import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', environmentOptions: { jsdom: { url: 'https://integrator.example/' } }, include: ['test/**/*.test.ts'], restoreMocks: true } });
