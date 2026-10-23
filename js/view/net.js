// Two players, one engine each, over PeerJS. No server of our own.
//
// THE WIRE CARRIES THE DECISION, NEVER THE BOARD.
//
// The engine is deterministic: the same seed and the same ordered list of
// actions and answers produce the same game on both machines (that is what
// tools/checklockstep.js proves after every rules change). So all that crosses
// the network is {seq, move} and a hash of the state the sender saw after it,
// which is how a desync is caught the moment it happens rather than three
// turns later when the two battlefields visibly disagree.
//
// Both sides run the full engine, so each browser technically holds the other
// player's hand in memory. This is a friendly game between two people, not a
// tournament client; the HUD never shows it. Said plainly rather than
// pretended away.

const BROKER = { debug: 1 };

/** Four-letter room codes, easy to read out loud. No I/O/0/1. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeCode() {
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(4));
  for (let i = 0; i < 4; i++) s += ALPHABET[r[i] % ALPHABET.length];
  return s;
}

const PREFIX = 'wizards-gambit-';

export class Net extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.code = null;
    this.seq = 0;           // how many moves WE have sent
    this.applied = 0;       // how many of THEIR moves have been delivered
    this.inbox = new Map(); // seq -> message, for out-of-order arrivals
    this.ready = false;
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /* ---------------------------------------------------------- connect */

  async host() {
    await loadPeerJS();
    this.isHost = true;
    for (let attempt = 0; ; attempt++) {
      const code = makeCode();
      try { this.peer = await openPeer(PREFIX + code); this.code = code; break; }
      catch (e) { if (attempt === 5) throw new Error('could not open a room — the broker may be busy'); }
    }
    this.peer.on('connection', (conn) => {
      if (this.conn) { conn.close(); return; }   // one opponent only
      this.#bind(conn);
    });
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch { /* gone */ } });
    this.#emit('hosting', { code: this.code });
    return this.code;
  }

  async join(code) {
    await loadPeerJS();
    this.isHost = false;
    this.code = code.toUpperCase().trim();
    this.peer = await openPeer(null);
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no room called ${this.code}`)), 12000);
      conn.on('open', () => { clearTimeout(t); resolve(); });
      conn.on('error', (e) => { clearTimeout(t); reject(e); });
      this.peer.on('error', (e) => { clearTimeout(t); reject(new Error(e.type === 'peer-unavailable' ? `no room called ${this.code}` : String(e))); });
    });
    this.#bind(conn);
    return this.code;
  }

  #bind(conn) {
    this.conn = conn;
    conn.on('data', (msg) => this.#receive(msg));
    conn.on('close', () => { this.ready = false; this.#emit('left', {}); });
    conn.on('error', (e) => this.#emit('neterror', { message: String(e) }));
    if (conn.open) this.#opened(); else conn.on('open', () => this.#opened());
  }

  #opened() {
    this.ready = true;
    this.#emit('joined', { isHost: this.isHost });
  }

  /* ---------------------------------------------------------- messages */

  send(msg) { if (this.conn && this.conn.open) this.conn.send(msg); }

  /** Guest -> host, on connecting. */
  sendHello(info) { this.send({ t: 'hello', info }); }
  /** Host -> guest: everything needed to build the same game. */
  sendSetup(setup) { this.seq = 0; this.applied = 0; this.inbox.clear(); this.send({ t: 'setup', setup }); }
  /** An action or an answer, in order, with the hash of the state after it. */
  sendMove(move, hash) { this.send({ t: 'move', seq: this.seq++, move, hash }); }
  sendChat(text) { this.send({ t: 'chat', text }); }

  #receive(msg) {
    if (!msg || !msg.t) return;
    if (msg.t === 'hello') { this.#emit('hello', msg.info || {}); return; }
    if (msg.t === 'setup') { this.seq = 0; this.applied = 0; this.inbox.clear(); this.#emit('setup', msg.setup); return; }
    if (msg.t === 'chat') { this.#emit('chat', { text: msg.text }); return; }
    if (msg.t === 'desync') { this.#emit('desync', msg); return; }
    if (msg.t !== 'move') return;
    this.inbox.set(msg.seq, msg);
    // Deliver in order. A reliable channel should not reorder, but a frame
    // that arrives late must not be applied out of sequence.
    while (this.inbox.has(this.applied)) {
      const next = this.inbox.get(this.applied);
      this.inbox.delete(this.applied);
      this.applied++;
      this.#emit('move', next);
    }
  }

  reportDesync(detail) { this.send({ t: 'desync', ...detail }); }

  close() {
    try { this.conn?.close(); } catch { /* already closed */ }
    try { this.peer?.destroy(); } catch { /* already gone */ }
    this.conn = null; this.peer = null; this.ready = false;
  }
}

/* ------------------------------------------------------------ plumbing */

let peerLoading = null;
function loadPeerJS() {
  if (window.Peer) return Promise.resolve();
  if (peerLoading) return peerLoading;
  peerLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    // Served with the site (vendor/peerjs 1.5.4), not from a CDN: a player
    // whose network blocks the CDN must still be able to join a room.
    s.src = new URL('../../vendor/peerjs/peerjs.min.js', import.meta.url).href;
    s.onload = resolve;
    s.onerror = () => { peerLoading = null; reject(new Error('could not load PeerJS — are you online?')); };
    document.head.appendChild(s);
  });
  return peerLoading;
}

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new window.Peer(id, BROKER) : new window.Peer(BROKER);
    const t = setTimeout(() => reject(new Error('the broker did not answer')), 12000);
    peer.on('open', () => { clearTimeout(t); resolve(peer); });
    peer.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
