// Entry point for /bin/c++ (C++ compiler via Clang)
export default async (): Promise<number> => {
  const { main } = await import('./main');
  return main();
};
