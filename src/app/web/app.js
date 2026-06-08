const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

const me = { slot: null };

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

const otherSlot = (s) => (s === "P1" ? "P2" : "P1");
const slotLabel = (s) => (s === "P1" ? "Player 1" : "Player 2");
const playerName = (s) => (s === me.slot ? "You" : slotLabel(s));
const aiName = (s) => (s === me.slot ? "Your AI" : `${slotLabel(s)}'s AI`);
const threadEl = (s) => $(s === "P1" ? "threadP1" : "threadP2");

function setThinking(msg) {
  if (msg) {
    $("thinkingText").textContent = msg;
    show("thinking");
  } else {
    hide("thinking");
  }
}

function addMsg(slot, who, text, ai) {
  const div = document.createElement("div");
  div.className = "msg" + (ai ? " ai" : "");
  div.innerHTML = `<div class="who">${who}</div>${text}`;
  const t = threadEl(slot);
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
}

function setupColumns() {
  for (const slot of ["P1", "P2"]) {
    $("name" + slot).textContent = slot === me.slot ? `${slotLabel(slot)} (you)` : slotLabel(slot);
    $("sub" + slot).textContent = `guessing ${slotLabel(otherSlot(slot))}'s secret`;
    $("status" + slot).textContent = "";
    $("status" + slot).className = "status";
    $("col" + slot).classList.remove("resolved");
  }
}

function clearThreads() {
  $("threadP1").innerHTML = "";
  $("threadP2").innerHTML = "";
}

function renderRemaining(remaining) {
  if (!remaining) return;
  for (const slot of ["P1", "P2"]) {
    $("left" + slot).textContent = `${remaining[slot]} question${remaining[slot] === 1 ? "" : "s"} left`;
  }
}

function markResolved(slot, result) {
  const s = $("status" + slot);
  s.textContent = result === "won" ? "✓ WON" : "✗ LOST";
  s.className = "status " + result;
  $("col" + slot).classList.add("resolved");
}

function setTurn(turn) {
  const banner = $("turnBanner");
  const yours = turn === me.slot;
  banner.className = "banner " + (yours ? "your-turn" : "their-turn");
  banner.textContent = yours
    ? `▶▶  YOUR TURN — ${slotLabel(turn)}  ·  ask a question or make a guess`
    : `${slotLabel(turn)}'s turn — waiting for them…`;
  $("colP1").classList.toggle("active", turn === "P1");
  $("colP2").classList.toggle("active", turn === "P2");
  $("askBtn").disabled = !yours;
  $("guessBtn").disabled = !yours;
  $("actionText").disabled = !yours;
}

function enterGame() {
  hide("secret");
  hide("result");
  show("game");
  setupColumns();
}

function resultSummary(results) {
  const mine = results[me.slot];
  const theirs = results[otherSlot(me.slot)];
  const them = slotLabel(otherSlot(me.slot));
  let headline;
  if (mine === "won" && theirs === "won") headline = "You both guessed it! 🤝";
  else if (mine === "won") headline = "You win! 🎉";
  else if (theirs === "won") headline = `${them} wins.`;
  else headline = "Nobody cracked it — double loss. 😅";
  const youText = mine === "won" ? "You guessed correctly." : "You ran out of questions.";
  const themText = theirs === "won" ? `${them} guessed correctly.` : `${them} ran out of questions.`;
  return `${headline}  —  ${youText} ${themText}`;
}

function handleEvent(e) {
  switch (e.type) {
    case "snapshot":
      if (e.snapshot.phase === "in-progress") {
        enterGame();
        clearThreads();
        for (const h of e.snapshot.history) {
          addMsg(h.askedBy, playerName(h.askedBy), h.question);
          addMsg(h.askedBy, aiName(otherSlot(h.askedBy)), h.answer, true);
        }
        renderRemaining(e.snapshot.remaining);
        for (const slot of ["P1", "P2"]) {
          if (e.snapshot.results[slot]) markResolved(slot, e.snapshot.results[slot]);
        }
        setTurn(e.snapshot.turn);
      }
      break;
    case "gameStarted":
      hide("lobby");
      show("secret");
      break;
    case "enterSecret":
      $("category").textContent = e.category;
      setThinking(null);
      hide("game");
      hide("result");
      show("secret");
      break;
    case "turnChanged":
      enterGame();
      setThinking(null);
      renderRemaining(e.remaining);
      setTurn(e.turn);
      break;
    case "questionAnswered":
      addMsg(e.askedBy, playerName(e.askedBy), e.question);
      addMsg(e.askedBy, aiName(e.answeredBySlot), e.answer, true);
      if (e.askedBy === me.slot) setThinking("🧠 Your AI is analyzing the answer…");
      break;
    case "analysis":
      addMsg(
        e.forSlot,
        `${aiName(e.forSlot)} ↳ strategy`,
        `<em>candidates:</em> ${e.candidates.join(", ") || "—"}<br><em>try:</em> ${e.followups.join(" / ") || "—"}`,
        true,
      );
      if (e.forSlot === me.slot) setThinking(null);
      break;
    case "guessResult":
      addMsg(e.bySlot, playerName(e.bySlot), `guessed "${e.guess}" — ${e.correct ? "correct! 🎉" : "nope"}`);
      if (e.bySlot === me.slot) setThinking(null);
      break;
    case "playerResolved":
      renderRemaining(e.remaining);
      markResolved(e.slot, e.result);
      if (e.slot === me.slot) setThinking(null);
      break;
    case "gameOver":
      setThinking(null);
      hide("game");
      show("result");
      $("winner").textContent = resultSummary(e.results);
      $("reveals").innerHTML = "";
      post("/local/reveal", {});
      break;
    case "secretRevealed": {
      const p = document.createElement("p");
      p.textContent = `${slotLabel(e.slot)}'s secret was: ${e.secret}`;
      $("reveals").appendChild(p);
      break;
    }
    case "rematch":
      setThinking(null);
      hide("result");
      clearThreads();
      break;
    case "playerLeft":
      setThinking(null);
      $("turnBanner").className = "banner their-turn";
      $("turnBanner").textContent = `${slotLabel(e.slot)} disconnected. Return to lobby.`;
      break;
  }
}

new EventSource("/local/stream").onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (e.type === "local") {
    if (e.note && e.note.includes("working")) setThinking("🧠 Your AI is working…");
    return;
  }
  handleEvent(e);
};

$("connectBtn").onclick = async () => {
  await post("/local/connect", { serverUrl: $("serverUrl").value, name: $("name").value || "Player" });
  hide("connect");
  show("lobby");
};
$("createBtn").onclick = async () => {
  const { code } = await post("/local/game/create", {});
  me.slot = "P1";
  $("code").textContent = code;
  show("codeLine");
};
$("joinBtn").onclick = async () => {
  const r = await post("/local/game/join", { code: $("joinCode").value.toUpperCase() });
  me.slot = r.slot;
};
$("secretBtn").onclick = async () => {
  await post("/local/secret", { secret: $("secretInput").value });
  enterGame();
  $("turnBanner").className = "banner their-turn";
  $("turnBanner").textContent = "Secret set — waiting for the other player…";
};
$("askBtn").onclick = async () => {
  const text = $("actionText").value.trim();
  if (!text) return;
  $("askBtn").disabled = true;
  $("guessBtn").disabled = true;
  $("actionText").disabled = true;
  $("actionText").value = "";
  setThinking(`🧠 Waiting for ${slotLabel(otherSlot(me.slot))}'s AI to answer…`);
  try { await post("/local/action", { type: "ask", text }); } catch (_) {}
};
$("guessBtn").onclick = async () => {
  const text = $("actionText").value.trim();
  if (!text) return;
  $("askBtn").disabled = true;
  $("guessBtn").disabled = true;
  $("actionText").disabled = true;
  $("actionText").value = "";
  setThinking("🧠 Checking your guess…");
  try { await post("/local/action", { type: "guess", text }); } catch (_) {}
};
$("rematchBtn").onclick = async () => {
  hide("result");
  await post("/local/rematch", {});
};
