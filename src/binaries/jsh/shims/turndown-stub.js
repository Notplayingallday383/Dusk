// Stub for turndown in the engine bundle.
//
// just-bash's html-to-markdown command uses turndown. We provide a minimal
// class shim that throws on use; importing the module doesn't crash the
// bundle, but running html-to-markdown will fail with a clear error.
class TurndownServiceStub {
  constructor() {
    this._notSupported();
  }
  turndown() { this._notSupported(); }
  addRule() { return this; }
  keep() { return this; }
  remove() { return this; }
  use() { return this; }
  _notSupported() {
    throw new Error("jsh: html-to-markdown (turndown) is not available in the DuskJS engine");
  }
}

export default TurndownServiceStub;
export { TurndownServiceStub as TurndownService };
