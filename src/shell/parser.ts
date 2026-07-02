import { type ShellToken } from './tokenizer';

export interface Redirect {
  type: '>' | '>>' | '<';
  target: string;
}

export interface Command {
  words: string[];
  redirects: Redirect[];
}

export interface Pipeline {
  commands: Command[];
}

export interface PipelineEntry {
  pipeline: Pipeline;
  operator?: '&&' | '||' | ';';
}

export interface CompoundList {
  pipelines: PipelineEntry[];
}

export class ParseError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ParseError'; }
}

export const parse = (tokens: ShellToken[]): CompoundList => {
  const result: PipelineEntry[] = [];
  let i = 0;

  const parseCommand = (): Command => {
    const words: string[] = [];
    const redirects: Redirect[] = [];

    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.type === 'op' && (t.value === '|' || t.value === ';' || t.value === '&&' || t.value === '||')) break;
      if (t.type === 'op' && (t.value === '>' || t.value === '>>' || t.value === '<')) {
        const redirType = t.value;
        i++;
        if (i >= tokens.length || tokens[i]!.type !== 'word') {
          throw new ParseError(`Expected filename after ${redirType}`);
        }
        redirects.push({ type: redirType, target: tokens[i]!.value });
        i++;
        continue;
      }
      words.push(t.value);
      i++;
    }

    if (words.length === 0 && redirects.length === 0) {
      throw new ParseError('Expected command');
    }

    return { words, redirects };
  };

  const parsePipeline = (): Pipeline => {
    const commands: Command[] = [parseCommand()];
    while (i < tokens.length && tokens[i]!.type === 'op' && tokens[i]!.value === '|') {
      i++;
      commands.push(parseCommand());
    }
    return { commands };
  };

  while (i < tokens.length) {
    const pipeline = parsePipeline();
    let operator: '&&' | '||' | ';' | undefined;
    if (i < tokens.length) {
      const t = tokens[i]!;
      if (t.type === 'op' && (t.value === '&&' || t.value === '||' || t.value === ';')) {
        operator = t.value;
        i++;
      }
    }
    result.push(operator !== undefined ? { pipeline, operator } : { pipeline });
    if ((operator === '&&' || operator === '||') && i >= tokens.length) {
      throw new ParseError(`Expected command after ${operator}`);
    }
  }

  return { pipelines: result };
};
