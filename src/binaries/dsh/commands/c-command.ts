// dsh custom command: c
//
// Same public CLI as /bin/c: inside dsh, c runs C code in one-shot mode.

// @ts-nocheck
import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, args: Record<string, unknown> = {}): unknown => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) throw new Error('c: ipc unavailable in this context');
  const r = ipc.send({ f, ...args });
  if (r.error) throw new Error(r.error);
  return r.value;
};

export const cCommand: Command = {
  name: 'c',
  trusted: true,
  async execute(argv: string[], ctx: CommandContext): Promise<ExecResult> {
    let inlineCode: string | null = null;
    let scriptPath: string | null = null;
    let readStdinFlag = false;
    const scriptArgs: string[] = [];

    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === '-c' && i + 1 < argv.length) {
        inlineCode = argv[i + 1]!;
        for (let j = i + 2; j < argv.length; j++) scriptArgs.push(argv[j]!);
        break;
      }
      if (a === '--version' || a === '-V') {
        try {
          const r = call('c.version') as { version: string };
          return { stdout: r.version + '\n', stderr: '', exitCode: 0 };
        } catch (e) {
          return { stdout: '', stderr: 'c: ' + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 };
        }
      }
      if (a === '--help' || a === '-h') {
        return {
          stdout: [
            'c (dsh built-in) [-c CODE | SCRIPT | -] [args...]',
            '  -c CODE      Execute CODE as C',
            '  -            Read script from stdin',
            '  SCRIPT       Path to a .c file',
            '',
            'Supported C features:',
            '  - Basic types: int, float, char',
            '  - stdio: printf(), putchar()',
            '  - Control flow: if, while, for',
            '  - Operators: +, -, *, /, ==, !=, <, >, <=, >=',
            '',
          ].join('\n'),
          stderr: '', exitCode: 0,
        };
      }
      if (a === '-') { readStdinFlag = true; for (let j = i + 1; j < argv.length; j++) scriptArgs.push(argv[j]!); break; }
      if (a.startsWith('-') && a.length > 1) {
        return { stdout: '', stderr: 'c: unrecognized option: ' + a + '\n', exitCode: 2 };
      }
      scriptPath = a;
      for (let j = i + 1; j < argv.length; j++) scriptArgs.push(argv[j]!);
      break;
    }

    const stdinText = typeof ctx.stdin === 'string' ? ctx.stdin : '';

    let code: string;
    let displayName = '<string>';
    if (inlineCode !== null) {
      code = inlineCode; displayName = '<-c>';
    } else if (readStdinFlag) {
      code = stdinText; displayName = '<stdin>';
    } else if (scriptPath !== null) {
      try {
        code = await ctx.fs.readFile(scriptPath);
      } catch (e) {
        return { stdout: '', stderr: "c: can't open file '" + scriptPath + "': " + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 2 };
      }
      displayName = scriptPath;
    } else if (stdinText.trim().length > 0) {
      // Piped code: treat stdin as script.
      code = stdinText; displayName = '<stdin>';
    } else {
      return {
        stdout: '',
        stderr: 'c: no script provided. Use -c CODE, SCRIPT, or pipe code via stdin.\n',
        exitCode: 2,
      };
    }

    try {
      const argvForC = [displayName, ...scriptArgs];
      const r = call('c.exec', {
        code, argv: argvForC, stdin: stdinText,
      }) as { stdout: string; stderr: string; exitCode: number };
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
    } catch (e) {
      return { stdout: '', stderr: 'c: ' + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 };
    }
  },
};
