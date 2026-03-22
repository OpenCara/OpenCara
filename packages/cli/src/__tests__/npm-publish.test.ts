import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLI_DIR = path.resolve(import.meta.dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf-8'));

describe('npm publish readiness', () => {
  describe('package.json required fields', () => {
    it('has name', () => {
      expect(pkg.name).toBe('opencara');
    });

    it('has description', () => {
      expect(typeof pkg.description).toBe('string');
      expect(pkg.description.length).toBeGreaterThan(0);
    });

    it('has license', () => {
      expect(pkg.license).toBe('MIT');
    });

    it('has repository', () => {
      expect(pkg.repository).toBeDefined();
      expect(pkg.repository.url).toContain('github.com/OpenCara/OpenCara');
      expect(pkg.repository.directory).toBe('packages/cli');
    });

    it('has homepage', () => {
      expect(typeof pkg.homepage).toBe('string');
      expect(pkg.homepage).toContain('github.com/OpenCara/OpenCara');
    });

    it('has bugs', () => {
      expect(pkg.bugs).toBeDefined();
      expect(pkg.bugs.url).toContain('github.com/OpenCara/OpenCara/issues');
    });

    it('has author', () => {
      expect(typeof pkg.author).toBe('string');
      expect(pkg.author.length).toBeGreaterThan(0);
    });

    it('has keywords', () => {
      expect(Array.isArray(pkg.keywords)).toBe(true);
      expect(pkg.keywords.length).toBeGreaterThan(0);
      expect(pkg.keywords).toContain('ai');
      expect(pkg.keywords).toContain('code-review');
      expect(pkg.keywords).toContain('cli');
    });

    it('has engines specifying node >= 20', () => {
      expect(pkg.engines).toBeDefined();
      expect(pkg.engines.node).toBe('>=20');
    });
  });

  describe('bin entry', () => {
    it('declares opencara bin', () => {
      expect(pkg.bin).toBeDefined();
      expect(pkg.bin.opencara).toBe('dist/index.js');
    });

    it('bin target has shebang line after build', () => {
      const binPath = path.join(CLI_DIR, pkg.bin.opencara);
      if (fs.existsSync(binPath)) {
        const content = fs.readFileSync(binPath, 'utf-8');
        expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
      }
    });
  });

  describe('files whitelist', () => {
    it('has files field', () => {
      expect(Array.isArray(pkg.files)).toBe(true);
    });

    it('includes dist directory', () => {
      expect(pkg.files).toContain('dist');
    });

    it('includes README.md', () => {
      expect(pkg.files).toContain('README.md');
    });

    it('does not include src (source should not be published)', () => {
      expect(pkg.files).not.toContain('src');
    });
  });

  describe('README', () => {
    it('README.md exists', () => {
      const readmePath = path.join(CLI_DIR, 'README.md');
      expect(fs.existsSync(readmePath)).toBe(true);
    });

    it('README has meaningful content', () => {
      const readmePath = path.join(CLI_DIR, 'README.md');
      const content = fs.readFileSync(readmePath, 'utf-8');
      expect(content.length).toBeGreaterThan(500);
      expect(content).toContain('opencara');
      expect(content).toContain('Quick Start');
      expect(content).toContain('npm i -g opencara');
    });
  });

  describe('no TypeScript declarations leak', () => {
    it('files whitelist does not include .d.ts patterns', () => {
      for (const entry of pkg.files) {
        expect(entry).not.toMatch(/\.d\.ts/);
      }
    });
  });

  describe('module type', () => {
    it('is ESM', () => {
      expect(pkg.type).toBe('module');
    });
  });

  describe('is not marked private', () => {
    it('private field is not true', () => {
      expect(pkg.private).not.toBe(true);
    });
  });
});
