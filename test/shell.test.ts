import { test, expect } from 'vitest';
import { tokenize, TokenizeError } from '../src/shell/tokenizer';
import { parse, ParseError } from '../src/shell/parser';

test('tokenize simple command', () => {
  const tokens = tokenize('echo hello');
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'hello' },
  ]);
});

test('tokenize with single quotes', () => {
  const tokens = tokenize("echo 'hello world'");
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'hello world' },
  ]);
});

test('tokenize with double quotes containing spaces', () => {
  const tokens = tokenize('echo "hello world"');
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'hello world' },
  ]);
});

test('tokenize with backslash escape', () => {
  const tokens = tokenize('echo a\\ b');
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'a b' },
  ]);
});

test('tokenize operators', () => {
  const tokens = tokenize('cd /tmp && echo ok || echo fail');
  expect(tokens).toEqual([
    { type: 'word', value: 'cd' },
    { type: 'word', value: '/tmp' },
    { type: 'op', value: '&&' },
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'ok' },
    { type: 'op', value: '||' },
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'fail' },
  ]);
});

test('tokenize pipe', () => {
  const tokens = tokenize('echo hello | wc -l');
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'hello' },
    { type: 'op', value: '|' },
    { type: 'word', value: 'wc' },
    { type: 'word', value: '-l' },
  ]);
});

test('tokenize redirects', () => {
  const tokens = tokenize('echo hello > out.txt');
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'hello' },
    { type: 'op', value: '>' },
    { type: 'word', value: 'out.txt' },
  ]);
});

test('tokenize append redirect', () => {
  const tokens = tokenize('echo hi >> log');
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'hi' },
    { type: 'op', value: '>>' },
    { type: 'word', value: 'log' },
  ]);
});

test('tokenize input redirect', () => {
  const tokens = tokenize('cat < in.txt');
  expect(tokens).toEqual([
    { type: 'word', value: 'cat' },
    { type: 'op', value: '<' },
    { type: 'word', value: 'in.txt' },
  ]);
});

test('parse simple command', () => {
  const ast = parse(tokenize('echo hello'));
  expect(ast.pipelines).toHaveLength(1);
  expect(ast.pipelines[0]!.pipeline.commands).toHaveLength(1);
  expect(ast.pipelines[0]!.pipeline.commands[0]!.words).toEqual(['echo', 'hello']);
  expect(ast.pipelines[0]!.pipeline.commands[0]!.redirects).toEqual([]);
});

test('parse pipeline', () => {
  const ast = parse(tokenize('echo hello | wc -l'));
  expect(ast.pipelines).toHaveLength(1);
  expect(ast.pipelines[0]!.pipeline.commands).toHaveLength(2);
  expect(ast.pipelines[0]!.pipeline.commands[0]!.words).toEqual(['echo', 'hello']);
  expect(ast.pipelines[0]!.pipeline.commands[1]!.words).toEqual(['wc', '-l']);
});

test('parse compound with &&', () => {
  const ast = parse(tokenize('cd /tmp && echo ok'));
  expect(ast.pipelines).toHaveLength(2);
  expect(ast.pipelines[0]!.operator).toBe('&&');
  expect(ast.pipelines[0]!.pipeline.commands[0]!.words).toEqual(['cd', '/tmp']);
  expect(ast.pipelines[1]!.pipeline.commands[0]!.words).toEqual(['echo', 'ok']);
});

test('parse compound with || and ;', () => {
  const ast = parse(tokenize('a || b ; c'));
  expect(ast.pipelines).toHaveLength(3);
  expect(ast.pipelines[0]!.operator).toBe('||');
  expect(ast.pipelines[1]!.operator).toBe(';');
  expect(ast.pipelines[2]!.operator).toBeUndefined();
});

test('parse redirect on command', () => {
  const ast = parse(tokenize('echo hello > out.txt'));
  const cmd = ast.pipelines[0]!.pipeline.commands[0]!;
  expect(cmd.words).toEqual(['echo', 'hello']);
  expect(cmd.redirects).toEqual([{ type: '>', target: 'out.txt' }]);
});

test('parse pipe with redirect on last command', () => {
  const ast = parse(tokenize('echo hello | wc -l > count.txt'));
  expect(ast.pipelines).toHaveLength(1);
  const pipeline = ast.pipelines[0]!.pipeline;
  expect(pipeline.commands).toHaveLength(2);
  expect(pipeline.commands[1]!.redirects).toEqual([{ type: '>', target: 'count.txt' }]);
});

test('parse error on dangling redirect', () => {
  expect(() => parse(tokenize('echo > '))).toThrow(/Expected filename/);
});

test('tokenize unterminated single quote throws', () => {
  expect(() => tokenize("echo 'hi")).toThrow(/Unterminated/);
});

test('tokenize unterminated double quote throws', () => {
  expect(() => tokenize('echo "hi')).toThrow(/Unterminated/);
});

test('tokenize trailing backslash throws', () => {
  expect(() => tokenize('echo \\')).toThrow(/Trailing backslash/);
});

test('tokenize empty input returns empty tokens', () => {
  expect(tokenize('')).toEqual([]);
});

test('tokenize mixed quote types concatenate into single word', () => {
  const tokens = tokenize('echo "a"\'b\'');
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'ab' },
  ]);
});

test('tokenize trailing whitespace produces no extra tokens', () => {
  expect(tokenize('echo hi   ')).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'hi' },
  ]);
});

test('parse empty input returns empty pipelines', () => {
  expect(parse([])).toEqual({ pipelines: [] });
});

test('parse leading operator throws', () => {
  expect(() => parse(tokenize('| echo hi'))).toThrow(ParseError);
});

test('parse missing command after && throws', () => {
  expect(() => parse(tokenize('a &&'))).toThrow(ParseError);
});

test('parse missing command after | throws', () => {
  expect(() => parse(tokenize('a |'))).toThrow(ParseError);
});

test('parse trailing semicolon is accepted', () => {
  const ast = parse(tokenize('a ;'));
  expect(ast.pipelines).toHaveLength(1);
  expect(ast.pipelines[0]!.operator).toBe(';');
  expect(ast.pipelines[0]!.pipeline.commands[0]!.words).toEqual(['a']);
});

test('tokenize 2> currently splits into word "2" and op ">" (stderr redirect unsupported v1)', () => {
  const tokens = tokenize('echo hi 2> err');
  expect(tokens).toEqual([
    { type: 'word', value: 'echo' },
    { type: 'word', value: 'hi' },
    { type: 'word', value: '2' },
    { type: 'op', value: '>' },
    { type: 'word', value: 'err' },
  ]);
});
