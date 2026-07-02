export const errnoTable = Object.freeze({
  E2BIG: 7,
  EACCES: 13,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  EAFNOSUPPORT: 97,
  EAGAIN: 11,
  EALREADY: 114,
  EBADF: 9,
  EBADMSG: 74,
  EBUSY: 16,
  ECANCELED: 125,
  ECHILD: 10,
  ECONNABORTED: 103,
  ECONNREFUSED: 111,
  ECONNRESET: 104,
  EDEADLK: 35,
  EDESTADDRREQ: 89,
  EDOM: 33,
  EDQUOT: 122,
  EEXIST: 17,
  EFAULT: 14,
  EFBIG: 27,
  EHOSTUNREACH: 113,
  EIDRM: 43,
  EILSEQ: 84,
  EINPROGRESS: 115,
  EINTR: 4,
  EINVAL: 22,
  EIO: 5,
  EISCONN: 106,
  EISDIR: 21,
  ELOOP: 40,
  EMFILE: 24,
  EMLINK: 31,
  EMSGSIZE: 90,
  EMULTIHOP: 72,
  ENAMETOOLONG: 36,
  ENETDOWN: 100,
  ENETRESET: 102,
  ENETUNREACH: 101,
  ENFILE: 23,
  ENOBUFS: 105,
  ENODATA: 61,
  ENODEV: 19,
  ENOENT: 2,
  ENOEXEC: 8,
  ENOLCK: 37,
  ENOLINK: 67,
  ENOMEM: 12,
  ENOMSG: 42,
  ENOPROTOOPT: 92,
  ENOSPC: 28,
  ENOSR: 63,
  ENOSTR: 60,
  ENOSYS: 38,
  ENOTCONN: 107,
  ENOTDIR: 20,
  ENOTEMPTY: 39,
  ENOTSOCK: 88,
  ENOTSUP: 95,
  ENOTTY: 25,
  ENXIO: 6,
  EOPNOTSUPP: 95,
  EOVERFLOW: 75,
  EPERM: 1,
  EPIPE: 32,
  EPROTO: 71,
  EPROTONOSUPPORT: 93,
  EPROTOTYPE: 91,
  ERANGE: 34,
  EROFS: 30,
  ESPIPE: 29,
  ESRCH: 3,
  ESTALE: 116,
  ETIME: 62,
  ETIMEDOUT: 110,
  ETXTBSY: 26,
  EWOULDBLOCK: 11,
  EXDEV: 18,
});

export type ErrnoName = keyof typeof errnoTable;

const errnoPrimary: Record<number, string> = {
  1: 'EPERM',
  2: 'ENOENT',
  3: 'ESRCH',
  4: 'EINTR',
  5: 'EIO',
  6: 'ENXIO',
  7: 'E2BIG',
  8: 'ENOEXEC',
  9: 'EBADF',
  10: 'ECHILD',
  11: 'EAGAIN',
  12: 'ENOMEM',
  13: 'EACCES',
  14: 'EFAULT',
  16: 'EBUSY',
  17: 'EEXIST',
  18: 'EXDEV',
  19: 'ENODEV',
  20: 'ENOTDIR',
  21: 'EISDIR',
  22: 'EINVAL',
  23: 'ENFILE',
  24: 'EMFILE',
  25: 'ENOTTY',
  26: 'ETXTBSY',
  27: 'EFBIG',
  28: 'ENOSPC',
  29: 'ESPIPE',
  30: 'EROFS',
  31: 'EMLINK',
  32: 'EPIPE',
  33: 'EDOM',
  34: 'ERANGE',
  35: 'EDEADLK',
  36: 'ENAMETOOLONG',
  37: 'ENOLCK',
  38: 'ENOSYS',
  39: 'ENOTEMPTY',
  40: 'ELOOP',
  42: 'ENOMSG',
  43: 'EIDRM',
  60: 'ENOSTR',
  61: 'ENODATA',
  62: 'ETIME',
  63: 'ENOSR',
  67: 'ENOLINK',
  71: 'EPROTO',
  72: 'EMULTIHOP',
  74: 'EBADMSG',
  75: 'EOVERFLOW',
  84: 'EILSEQ',
  88: 'ENOTSOCK',
  89: 'EDESTADDRREQ',
  90: 'EMSGSIZE',
  91: 'EPROTOTYPE',
  92: 'ENOPROTOOPT',
  93: 'EPROTONOSUPPORT',
  95: 'ENOTSUP',
  97: 'EAFNOSUPPORT',
  98: 'EADDRINUSE',
  99: 'EADDRNOTAVAIL',
  100: 'ENETDOWN',
  101: 'ENETUNREACH',
  102: 'ENETRESET',
  103: 'ECONNABORTED',
  104: 'ECONNRESET',
  105: 'ENOBUFS',
  106: 'EISCONN',
  107: 'ENOTCONN',
  110: 'ETIMEDOUT',
  111: 'ECONNREFUSED',
  113: 'EHOSTUNREACH',
  114: 'EALREADY',
  115: 'EINPROGRESS',
  116: 'ESTALE',
  122: 'EDQUOT',
  125: 'ECANCELED',
};

export const errnoToName = (n: number): string | undefined => errnoPrimary[n];

export const nameToErrno = (name: string): number | undefined =>
  (errnoTable as Record<string, number>)[name];

export const errnoMessages: Record<string, string> = Object.freeze({
  E2BIG: 'argument list too long',
  EACCES: 'permission denied',
  EADDRINUSE: 'address already in use',
  EADDRNOTAVAIL: 'address not available',
  EAFNOSUPPORT: 'address family not supported',
  EAGAIN: 'resource temporarily unavailable',
  EALREADY: 'connection already in progress',
  EBADF: 'bad file descriptor',
  EBADMSG: 'bad message',
  EBUSY: 'device or resource busy',
  ECANCELED: 'operation canceled',
  ECHILD: 'no child processes',
  ECONNABORTED: 'connection aborted',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset by peer',
  EDEADLK: 'resource deadlock avoided',
  EDESTADDRREQ: 'destination address required',
  EDOM: 'mathematics argument out of domain of function',
  EDQUOT: 'disk quota exceeded',
  EEXIST: 'file exists',
  EFAULT: 'bad address',
  EFBIG: 'file too large',
  EHOSTUNREACH: 'host is unreachable',
  EIDRM: 'identifier removed',
  EILSEQ: 'illegal byte sequence',
  EINPROGRESS: 'operation in progress',
  EINTR: 'interrupted system call',
  EINVAL: 'invalid argument',
  EIO: 'i/o error',
  EISCONN: 'socket is connected',
  EISDIR: 'illegal operation on a directory',
  ELOOP: 'too many symbolic links encountered',
  EMFILE: 'too many open files',
  EMLINK: 'too many links',
  EMSGSIZE: 'message too long',
  EMULTIHOP: 'multihop attempted',
  ENAMETOOLONG: 'file name too long',
  ENETDOWN: 'network is down',
  ENETRESET: 'connection aborted by network',
  ENETUNREACH: 'network is unreachable',
  ENFILE: 'too many files open in system',
  ENOBUFS: 'no buffer space available',
  ENODATA: 'no message is available on the stream head read queue',
  ENODEV: 'no such device',
  ENOENT: 'no such file or directory',
  ENOEXEC: 'exec format error',
  ENOLCK: 'no record locks available',
  ENOLINK: 'link has been severed',
  ENOMEM: 'not enough memory',
  ENOMSG: 'no message of the desired type',
  ENOPROTOOPT: 'protocol not available',
  ENOSPC: 'no space left on device',
  ENOSR: 'no stream resources',
  ENOSTR: 'not a stream',
  ENOSYS: 'function not implemented',
  ENOTCONN: 'the socket is not connected',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  ENOTSOCK: 'not a socket',
  ENOTSUP: 'operation not supported',
  ENOTTY: 'inappropriate ioctl for device',
  ENXIO: 'no such device or address',
  EOPNOTSUPP: 'operation not supported on socket',
  EOVERFLOW: 'value too large to be stored in data type',
  EPERM: 'operation not permitted',
  EPIPE: 'broken pipe',
  EPROTO: 'protocol error',
  EPROTONOSUPPORT: 'protocol not supported',
  EPROTOTYPE: 'protocol wrong type for socket',
  ERANGE: 'result too large',
  EROFS: 'read-only file system',
  ESPIPE: 'invalid seek',
  ESRCH: 'no such process',
  ESTALE: 'stale file handle',
  ETIME: 'stream ioctl timeout',
  ETIMEDOUT: 'connection timed out',
  ETXTBSY: 'text file busy',
  EWOULDBLOCK: 'operation would block',
  EXDEV: 'cross-device link not permitted',
});

export const signalTable = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
});

export type SignalName = keyof typeof signalTable;

const signalPrimary: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  7: 'SIGBUS',
  8: 'SIGFPE',
  9: 'SIGKILL',
  10: 'SIGUSR1',
  11: 'SIGSEGV',
  12: 'SIGUSR2',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
  16: 'SIGSTKFLT',
  17: 'SIGCHLD',
  18: 'SIGCONT',
  19: 'SIGSTOP',
  20: 'SIGTSTP',
  21: 'SIGTTIN',
  22: 'SIGTTOU',
  23: 'SIGURG',
  24: 'SIGXCPU',
  25: 'SIGXFSZ',
  26: 'SIGVTALRM',
  27: 'SIGPROF',
  28: 'SIGWINCH',
  29: 'SIGIO',
  30: 'SIGPWR',
  31: 'SIGSYS',
};

export const signalToName = (n: number): string | undefined => signalPrimary[n];

export const nameToSignal = (name: string): number | undefined =>
  (signalTable as Record<string, number>)[name];

export type SignalAction = 'terminate' | 'core' | 'ignore' | 'stop' | 'continue';

export const defaultSignalAction = (name: string): SignalAction => {
  switch (name) {
    case 'SIGHUP':
    case 'SIGINT':
    case 'SIGPIPE':
    case 'SIGALRM':
    case 'SIGTERM':
    case 'SIGUSR1':
    case 'SIGUSR2':
    case 'SIGPROF':
    case 'SIGVTALRM':
    case 'SIGIO':
    case 'SIGPWR':
    case 'SIGSTKFLT':
      return 'terminate';
    case 'SIGQUIT':
    case 'SIGILL':
    case 'SIGABRT':
    case 'SIGFPE':
    case 'SIGSEGV':
    case 'SIGBUS':
    case 'SIGTRAP':
    case 'SIGXCPU':
    case 'SIGXFSZ':
    case 'SIGSYS':
      return 'core';
    case 'SIGCHLD':
    case 'SIGURG':
    case 'SIGWINCH':
      return 'ignore';
    case 'SIGSTOP':
    case 'SIGTSTP':
    case 'SIGTTIN':
    case 'SIGTTOU':
      return 'stop';
    case 'SIGCONT':
      return 'continue';
    case 'SIGKILL':
      return 'terminate';
    default:
      return 'terminate';
  }
};

export const fsConstants = Object.freeze({
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0o100,
  O_EXCL: 0o200,
  O_NOCTTY: 0o400,
  O_TRUNC: 0o1000,
  O_APPEND: 0o2000,
  O_NONBLOCK: 0o4000,
  O_DSYNC: 0o10000,
  O_SYNC: 0o4010000,
  O_RSYNC: 0o4010000,
  O_DIRECTORY: 0o200000,
  O_NOFOLLOW: 0o400000,
  O_CLOEXEC: 0o2000000,

  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
  S_IFLNK: 0o120000,
  S_IFCHR: 0o020000,
  S_IFBLK: 0o060000,
  S_IFIFO: 0o010000,
  S_IFSOCK: 0o140000,
  S_IRWXU: 0o700,
  S_IRUSR: 0o400,
  S_IWUSR: 0o200,
  S_IXUSR: 0o100,
  S_IRWXG: 0o070,
  S_IRGRP: 0o040,
  S_IWGRP: 0o020,
  S_IXGRP: 0o010,
  S_IRWXO: 0o007,
  S_IROTH: 0o004,
  S_IWOTH: 0o002,
  S_IXOTH: 0o001,

  F_OK: 0,
  X_OK: 1,
  W_OK: 2,
  R_OK: 4,

  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,

  UV_FS_COPYFILE_EXCL: 1,
  UV_FS_COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4,

  UV_DIRENT_UNKNOWN: 0,
  UV_DIRENT_FILE: 1,
  UV_DIRENT_DIR: 2,
  UV_DIRENT_LINK: 3,
  UV_DIRENT_FIFO: 4,
  UV_DIRENT_SOCKET: 5,
  UV_DIRENT_CHAR: 6,
  UV_DIRENT_BLOCK: 7,
});

export const priorityConstants = Object.freeze({
  PRIORITY_LOW: 19,
  PRIORITY_BELOW_NORMAL: 10,
  PRIORITY_NORMAL: 0,
  PRIORITY_ABOVE_NORMAL: -7,
  PRIORITY_HIGH: -14,
  PRIORITY_HIGHEST: -20,
});

export const dlopenConstants = Object.freeze({
  RTLD_LAZY: 1,
  RTLD_NOW: 2,
  RTLD_GLOBAL: 8,
  RTLD_LOCAL: 4,
  RTLD_DEEPBIND: 16,
});

export const osConstants = Object.freeze({
  UV_UDP_REUSEADDR: 4,
  dlopen: dlopenConstants,
  errno: errnoTable,
  signals: signalTable,
  priority: priorityConstants,
});

export const allConstants = Object.freeze({
  os: osConstants,
  fs: fsConstants,
  errno: errnoTable,
  signals: signalTable,
  priority: priorityConstants,
  dlopen: dlopenConstants,
});
