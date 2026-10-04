const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Minimal browser fixtures let race conditions run deterministically without dependencies.
function createGame(options = {}) {
  const elements = new Map();
  const workers = [];
  const urls = new Set();
  const timers = new Map();
  const events = new Map();
  const alerts = [];
  const audio = [];

  function createElement() {
    const classes = new Set();
    return {
      style: {}, children: [], disabled: false, textContent: "",
      set id(value) { elements.set(value, this); },
      set innerHTML(value) { this.children = []; },
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      },
      appendChild(child) { this.children.push(child); },
      addEventListener() {},
      getBoundingClientRect: () => ({ width: 400, height: 500 }),
    };
  }
  for (const id of ["board", "step-display", "victory-overlay", "victory-steps", "btn-hint", "btn-voice", "elevator-floor"]) {
    elements.set(id, createElement());
  }
  class FakeWorker {
    constructor(url) {
      if (options.constructorError) throw new Error("Worker unavailable");
      this.url = url;
      this.terminated = false;
      workers.push(this);
    }
    postMessage(data) {
      if (options.postMessageError) throw new Error("Cannot send");
      this.data = structuredClone(data);
    }
    terminate() { this.terminated = true; }
  }
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.paused = true;
      this.ended = false;
      audio.push(this);
    }
    load() {}
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  let nextUrl = 0;
  let nextTimer = 0;
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id), createElement, addEventListener() {},
    },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    Worker: FakeWorker, Audio: FakeAudio, Blob,
    URL: {
      createObjectURL() { const url = `blob:${++nextUrl}`; urls.add(url); return url; },
      revokeObjectURL: (url) => urls.delete(url),
    },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    alert: (message) => alerts.push(message),
  });
  vm.runInContext(script, context);
  const evaluate = (code) => vm.runInContext(code, context);
  evaluate("resetGame()");
  return { evaluate, workers, urls, timers, events, elements, alerts, audio };
}

function solve(game, layout = game.evaluate("INITIAL_LAYOUT")) {
  let response;
  const context = vm.createContext({ self: { postMessage: (data) => { response = structuredClone(data); } } });
  vm.runInContext(game.evaluate("workerCode"), context);
  context.self.onmessage({ data: structuredClone(layout) });
  return response;
}

function replay(layout, moves) {
  const blocks = structuredClone(layout);
  const sizes = { "2x2": [2, 2], "1x2": [1, 2], "2x1": [2, 1], "1x1": [1, 1] };
  for (const move of moves) {
    assert.equal(Math.abs(move.dx) + Math.abs(move.dy), 1);
    const block = blocks.find((b) => b.id === move.id);
    assert.ok(block, `Unknown role ${move.id}`);
    block.x += move.dx;
    block.y += move.dy;
    const occupied = new Set();
    for (const b of blocks) {
      const [w, h] = sizes[b.type];
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + w <= 4 && b.y + h <= 5);
      for (let y = b.y; y < b.y + h; y++) {
        for (let x = b.x; x < b.x + w; x++) {
          const cell = y * 4 + x;
          assert.ok(!occupied.has(cell), `Collision after moving ${move.id}`);
          occupied.add(cell);
        }
      }
    }
  }
  return blocks;
}

test("BFS preserves the 116-step shortest solution and role identities", () => {
  const game = createGame();
  const initial = structuredClone(game.evaluate("INITIAL_LAYOUT"));
  const result = solve(game, initial);
  assert.equal(result.success, true);
  assert.equal(result.moves.length, 116);
  const final = replay(initial, result.moves).find((b) => b.id === "michelle");
  assert.deepEqual([final.x, final.y], [1, 3]);

  const intermediate = replay(initial, result.moves.slice(0, 30));
  const continuation = solve(game, intermediate);
  assert.equal(continuation.moves.length, 86);
  const winner = replay(intermediate, continuation.moves).find((b) => b.id === "michelle");
  assert.deepEqual([winner.x, winner.y], [1, 3]);
  assert.deepEqual(solve(game, replay(initial, result.moves)).moves, []);

  // Exchange identities and reorder the input to exercise symmetry and parent reconstruction.
  [initial[1].id, initial[2].id] = [initial[2].id, initial[1].id];
  initial.reverse();
  const swapped = solve(game, initial);
  assert.equal(swapped.moves.length, 116);
  replay(initial, swapped.moves);
});

test("completed hints release workers and URLs; subsequent hints use the cached path", () => {
  const game = createGame();
  const result = solve(game);
  for (let i = 0; i < 8; i++) {
    game.evaluate("resetGame(); getHint()");
    const worker = game.workers.at(-1);
    assert.ok(worker.data.every((b) => !("img" in b)));
    worker.onmessage({ data: result });
    assert.equal(game.urls.size, 0);
    assert.ok(game.workers.every((w) => w.terminated));
    assert.equal(game.evaluate("steps"), 1);
    const count = game.workers.length;
    game.evaluate("getHint()");
    assert.equal(game.workers.length, count);
    assert.equal(game.evaluate("steps"), 2);
  }
});

test("manual moves cancel computation and queued old messages cannot overwrite a new request", () => {
  const game = createGame();
  const oldResult = solve(game);
  game.evaluate("getHint()");
  const oldWorker = game.workers.at(-1);
  const queuedMessage = oldWorker.onmessage;
  game.evaluate("moveBlock('otae', 1, 0); moveBlock('otae', 1, 0)");
  assert.equal(oldWorker.terminated, true);
  assert.equal(game.urls.size, 0);
  assert.equal(game.evaluate("steps"), 2);
  game.evaluate("getHint()");
  const newWorker = game.workers.at(-1);
  queuedMessage({ data: oldResult });
  assert.equal(game.evaluate("steps"), 2);
  assert.equal(newWorker.terminated, false);
  assert.equal(game.evaluate("hintComputing"), true);
  newWorker.onmessage({ data: solve(game, newWorker.data) });
  assert.equal(game.evaluate("steps"), 3);
  assert.equal(newWorker.terminated, true);
});

test("failed cached moves do not count steps and cause a fresh search", () => {
  const game = createGame();
  game.evaluate(`hintSolution = [{id: 'michelle', dx: 0, dy: -1}];
    hintStateKey = getBoardStateKey(); getHint()`);
  assert.equal(game.evaluate("steps"), 0);
  assert.equal(game.evaluate("hintIndex"), 0);
  assert.equal(game.evaluate("hintComputing"), true);
  assert.equal(game.workers.length, 1);
});

test("reset and pagehide release pending work, while reset clears drag and victory timers", () => {
  const game = createGame();
  game.evaluate("getHint(); startDrag('otae', 0, 0); victoryTimer = setTimeout(showVictory, 300); resetGame()");
  assert.equal(game.evaluate("dragState"), null);
  assert.equal(game.timers.size, 0);
  assert.equal(game.urls.size, 0);
  assert.equal(game.evaluate("hintComputing"), false);
  game.evaluate("getHint(); tryPlayAudio('audio/1x1.mp3')");
  game.events.get("pagehide")();
  assert.equal(game.urls.size, 0);
  assert.ok(game.workers.every((w) => w.terminated));
  assert.ok(game.audio.every((a) => a.paused));
});

test("worker failures, startup failures, and unsolved results release resources and restore the button", () => {
  for (const event of ["onerror", "onmessageerror", "no-solution"]) {
    const game = createGame();
    game.evaluate("getHint()");
    const worker = game.workers[0];
    if (event === "no-solution") worker.onmessage({ data: { success: false } });
    else worker[event]();
    assert.equal(worker.terminated, true);
    assert.equal(game.urls.size, 0);
    assert.equal(game.elements.get("btn-hint").disabled, false);
    assert.equal(game.evaluate("steps"), 0);
  }
  for (const options of [{ constructorError: true }, { postMessageError: true }]) {
    const game = createGame(options);
    game.evaluate("getHint()");
    assert.equal(game.urls.size, 0);
    assert.ok(game.workers.every((w) => w.terminated));
    assert.equal(game.elements.get("btn-hint").disabled, false);
    assert.equal(game.alerts.length, 1);
  }
});

test("1000 moves keep audio instances bounded and only redraw floors when their value changes", () => {
  const game = createGame();
  const floor = game.elements.get("elevator-floor");
  const firstGrid = floor.children[0];
  for (let i = 0; i < 1000; i++) {
    assert.equal(game.evaluate(`moveBlock('otae', ${i % 2 === 0 ? 1 : -1}, 0)`), true);
    if (i < 49) assert.equal(floor.children[0], firstGrid);
  }
  assert.equal(game.evaluate("steps"), 1000);
  assert.equal(game.audio.length, 4);
  assert.equal(game.evaluate("displayedFloor"), 7);
  assert.equal(game.workers.length, 0);
  game.evaluate("resetGame()");
  assert.equal(game.evaluate("displayedFloor"), 1);
  assert.ok(game.audio.every((a) => a.paused));
});
