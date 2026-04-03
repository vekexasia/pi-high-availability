declare module "proper-lockfile" {
  interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | { retries: number; factor?: number; minTimeout?: number; maxTimeout?: number; randomize?: boolean };
    realpath?: boolean;
    onCompromised?: (err: Error) => void;
    lockfilePath?: string;
  }

  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  function lockSync(file: string, options?: LockOptions): () => void;
  function unlock(file: string, options?: LockOptions): Promise<void>;
  function unlockSync(file: string, options?: LockOptions): void;
  function check(file: string, options?: LockOptions): Promise<boolean>;
  function checkSync(file: string, options?: LockOptions): boolean;

  export { lock, lockSync, unlock, unlockSync, check, checkSync };
}
