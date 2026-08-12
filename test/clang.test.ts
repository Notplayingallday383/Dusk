// Real Clang compiler tests - Full C11/C++17 support via YoWASP

import { describe, it, expect } from 'vitest';
import { bootRepl } from '../src/index';

const decode = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
};

// Run a C program via /bin/c
const runC = async (code: string, filename = 'program.c'): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  try {
    // Write to file
    await repl.processManager.spawn('/bin/sh', ['-c', `echo '${code}' > /tmp/${filename}`], { cwd: '/' });
    const r = await repl.processManager.spawnSync('/bin/c', [`/tmp/${filename}`], { cwd: '/' });
    return { stdout: decode(r.stdout), stderr: decode(r.stderr), exitCode: r.status };
  } finally {
    repl.engine.terminate();
  }
};

// Run a C++ program via /bin/c++
const runCpp = async (code: string, filename = 'program.cpp'): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  try {
    // Write to file
    await repl.processManager.spawn('/bin/sh', ['-c', `echo '${code}' > /tmp/${filename}`], { cwd: '/' });
    const r = await repl.processManager.spawnSync('/bin/c++', [`/tmp/${filename}`], { cwd: '/' });
    return { stdout: decode(r.stdout), stderr: decode(r.stderr), exitCode: r.status };
  } finally {
    repl.engine.terminate();
  }
};

describe('Clang Compiler (YoWASP)', () => {
  describe('C Compilation', () => {
    it('should compile hello world', async () => {
      const code = '#include <stdio.h>\\nint main() { printf(\\"Hello Clang!\\\\n\\"); return 0; }';
      const r = await runC(code);
      // Compilation should succeed (we're not executing yet, just compiling)
      expect(r.exitCode).toBe(0);
    }, 60000); // 60s timeout for first download

    it('should support functions', async () => {
      const code = `#include <stdio.h>
int add(int a, int b) { return a + b; }
int main() { printf("Result: %d\\\\n", add(5, 3)); return 0; }`;
      const r = await runC(code);
      expect(r.exitCode).toBe(0);
    }, 30000);

    it('should support pointers', async () => {
      const code = `#include <stdio.h>
int main() {
  int x = 42;
  int *p = &x;
  printf("Value: %d\\\\n", *p);
  return 0;
}`;
      const r = await runC(code);
      expect(r.exitCode).toBe(0);
    }, 30000);

    it('should support structs', async () => {
      const code = `#include <stdio.h>
struct Point {
  int x;
  int y;
};
int main() {
  struct Point p = {10, 20};
  printf("Point: (%d, %d)\\\\n", p.x, p.y);
  return 0;
}`;
      const r = await runC(code);
      expect(r.exitCode).toBe(0);
    }, 30000);

    it('should support arrays', async () => {
      const code = `#include <stdio.h>
int main() {
  int arr[5] = {1, 2, 3, 4, 5};
  int sum = 0;
  for(int i = 0; i < 5; i++) sum += arr[i];
  printf("Sum: %d\\\\n", sum);
  return 0;
}`;
      const r = await runC(code);
      expect(r.exitCode).toBe(0);
    }, 30000);

    it('should support recursion', async () => {
      const code = `#include <stdio.h>
int factorial(int n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
int main() {
  printf("5! = %d\\\\n", factorial(5));
  return 0;
}`;
      const r = await runC(code);
      expect(r.exitCode).toBe(0);
    }, 30000);

    it('should detect syntax errors', async () => {
      const code = '#include <stdio.h>\\nint main() { printf(\\"missing semicolon\\") return 0; }';
      const r = await runC(code);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('error');
    }, 30000);
  });

  describe('C++ Compilation', () => {
    it('should compile C++ hello world', async () => {
      const code = '#include <iostream>\\nint main() { std::cout << \\"Hello C++!\\" << std::endl; return 0; }';
      const r = await runCpp(code);
      expect(r.exitCode).toBe(0);
    }, 60000);

    it('should support std::vector', async () => {
      const code = `#include <iostream>
#include <vector>
int main() {
  std::vector<int> v = {1, 2, 3, 4, 5};
  std::cout << "Size: " << v.size() << std::endl;
  return 0;
}`;
      const r = await runCpp(code);
      expect(r.exitCode).toBe(0);
    }, 30000);

    it('should support classes', async () => {
      const code = `#include <iostream>
class Cat {
public:
  void meow() { std::cout << "Meow!" << std::endl; }
};
int main() {
  Cat c;
  c.meow();
  return 0;
}`;
      const r = await runCpp(code);
      expect(r.exitCode).toBe(0);
    }, 30000);

    it('should support templates', async () => {
      const code = `#include <iostream>
template<typename T>
T max(T a, T b) {
  return (a > b) ? a : b;
}
int main() {
  std::cout << max(5, 10) << std::endl;
  return 0;
}`;
      const r = await runCpp(code);
      expect(r.exitCode).toBe(0);
    }, 30000);
  });

  describe('Version and Help', () => {
    it('should show Clang version', async () => {
      const out: string[] = [];
      const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
      try {
        const r = await repl.processManager.spawnSync('/bin/c', ['--version'], { cwd: '/' });
        const stdout = decode(r.stdout);
        expect(stdout).toContain('clang');
        expect(stdout).toContain('22.');
        expect(r.status).toBe(0);
      } finally {
        repl.engine.terminate();
      }
    }, 60000);

    it('should show help text', async () => {
      const out: string[] = [];
      const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
      try {
        const r = await repl.processManager.spawnSync('/bin/c', ['--help'], { cwd: '/' });
        const stdout = decode(r.stdout);
        expect(stdout).toContain('Clang');
        expect(stdout).toContain('C11');
        expect(r.status).toBe(0);
      } finally {
        repl.engine.terminate();
      }
    }, 30000);
  });
});
