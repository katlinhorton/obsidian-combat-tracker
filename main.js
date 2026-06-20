'use strict';

/*
 * Combat Tracker — Obsidian Plugin
 * Full encounter tracker: initiative order, mob HP (per-creature), individual creatures,
 * AoE/attack/heal actions, bestiary autocomplete, and a player-facing popout display.
 *
 * Author: Katlin John
 * License: MIT
 */

const { Plugin, ItemView, Modal, Setting, PluginSettingTab, MarkdownRenderer, setIcon } = require('obsidian');

const VIEW_TYPE        = 'combat-tracker';
const PLAYER_VIEW_TYPE = 'combat-tracker-player';

const DEFAULT_BESTIARY_PATHS = [
  '3-Mechanics/CLI/compendium/bestiary',
  '3-Homebrew/Beasts',
];

const DEFAULT_SETTINGS = {
  bestiaryPaths: [...DEFAULT_BESTIARY_PATHS],
  partyFolder: '',
  entries: [],
  round: 1,
  currentTurnId: null,
};

// ──────────────────────────── Bestiary parsing ────────────────────────────────

function parseStatblock(text) {
  const block = /```statblock([\s\S]*?)```/.exec(text)?.[1];
  if (!block) return null;

  const str = k => new RegExp(`"${k}":\\s*"([^"]+)"`).exec(block)?.[1] ?? null;
  const int = k => { const m = new RegExp(`"${k}":\\s*!!int\\s*"(\\d+)"`).exec(block); return m ? +m[1] : null; };

  const name = str('name');
  const ac   = int('ac');
  const hp   = int('hp');
  if (!name || !ac || !hp) return null;

  const atkM = /(?:Attack Roll|Weapon Attack).*?text\(([+-]?\d+)\)/i.exec(block);
  const attackBonus = atkM ? +atkM[1] : null;

  const dmgM = /avg\|text\(\d+\)\s*\(([^)]+)\)/i.exec(block);
  const damage = dmgM ? dmgM[1].replace(/\\/g, '').replace(/\s+/g, ' ').trim() : null;

  const cr = str('cr');

  // DEX score → initiative modifier
  let initiativeModifier = 0;
  const statsIdx = block.indexOf('"stats":');
  if (statsIdx >= 0) {
    const scores = [...block.slice(statsIdx, statsIdx + 300).matchAll(/!!int\s*"(\d+)"/g)]
      .map(m => +m[1]);
    if (scores.length >= 2) initiativeModifier = Math.floor((scores[1] - 10) / 2);
  }

  return { name, ac, hp, attackBonus, damage, cr, initiativeModifier };
}

async function buildBestiary(app, paths) {
  const idx = new Map();
  const searchPaths = paths?.length ? paths : DEFAULT_BESTIARY_PATHS;

  // 1. Try statblocks plugin's in-memory bestiary
  const sbp = app.plugins?.plugins?.['obsidian-5e-statblocks'];
  if (sbp?.bestiary instanceof Map && sbp.bestiary.size > 0) {
    for (const [, c] of sbp.bestiary) {
      if (!c.name) continue;
      const ac = +c.ac || null, hp = +c.hp || null;
      if (!ac || !hp) continue;

      let attackBonus = null, damage = null;
      for (const a of (c.actions ?? [])) {
        const d = a.desc ?? '';
        if (attackBonus === null) {
          const m = /(?:Attack Roll|Weapon Attack).*?text\(([+-]?\d+)\)/i.exec(d)
                 ?? /(?:Attack Roll|Weapon Attack):\s*([+-]?\d+)/i.exec(d);
          if (m) attackBonus = +m[1];
        }
        if (damage === null) {
          const m = /avg\|text\(\d+\)\s*\(([^)]+)\)/i.exec(d);
          if (m) damage = m[1].replace(/\\/g, '').replace(/\s+/g, ' ').trim();
        }
        if (attackBonus !== null && damage !== null) break;
      }

      let initiativeModifier = 0;
      const dex = c.stats?.[1] ?? null;
      if (dex !== null) initiativeModifier = Math.floor((dex - 10) / 2);

      idx.set(c.name.toLowerCase(), { name: c.name, ac, hp, cr: c.cr ?? null, attackBonus, damage, initiativeModifier });
    }
    if (idx.size > 0) return idx;
  }

  // 2. Parse vault files in configured paths
  const files = app.vault.getMarkdownFiles().filter(f => searchPaths.some(p => f.path.startsWith(p)));
  for (const f of files) {
    try {
      const parsed = parseStatblock(await app.vault.cachedRead(f));
      if (parsed) idx.set(parsed.name.toLowerCase(), { ...parsed, path: f.path });
    } catch {}
  }

  return idx;
}

// ──────────────────────────── Helpers ─────────────────────────────────────────

function calcHits(count, attackBonus, targetAC) {
  const needed = Math.max(2, Math.min(20, targetAC - attackBonus));
  return Math.floor(count * (21 - needed) / 20);
}

function rollD20(modifier = 0) {
  return Math.floor(Math.random() * 20) + 1 + modifier;
}

function sortedByInitiative(entries) {
  return [...entries].sort((a, b) => {
    const ai = a.initiative, bi = b.initiative;
    if (ai === null && bi === null) return 0;
    if (ai === null) return 1;
    if (bi === null) return -1;
    if (bi !== ai) return bi - ai;
    const ap = a.type === 'player' ? 0 : 1;
    const bp = b.type === 'player' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (b.initiativeModifier ?? 0) - (a.initiativeModifier ?? 0);
  });
}

async function loadPlayersFromVault(app, folderPath) {
  if (!folderPath) return [];
  const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
  const files = app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix));
  const players = [];
  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    if (fm.Role !== 'Player') continue;
    if (fm.Status && fm.Status !== 'Active') continue;
    players.push({
      id: uid(),
      type: 'player',
      name: file.basename,
      initiative: null,
      initiativeModifier: fm.initiative ?? 0,
      ac: fm.ac ?? 10,
      bestiaryPath: file.path,
    });
  }
  return players;
}

async function findCreatureImage(app, entry) {
  const sourcePath = entry.bestiaryPath ?? null;
  if (!sourcePath) return null;

  let content;
  try {
    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (!file) return null;
    content = await app.vault.cachedRead(file);
  } catch { return null; }

  const imgM = /"image":\s*"?\[\[([^\]]+?)\]\]"?/i.exec(content)
            ?? /!\[\[([^\]|]+?\.(png|jpe?g|webp|gif|svg))[^\]]*\]\]/i.exec(content);
  if (!imgM) return null;

  const linkpath = imgM[1].split('|')[0].trim();
  const imgFile  = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  if (!imgFile) return null;

  return app.vault.getResourcePath(imgFile);
}

function uid() {
  return `ct-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ──────────────────────────── Combat Tracker View ─────────────────────────────

class CombatTrackerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeStatblockId = null;
    this._headerEl    = null;
    this._entriesEl   = null;
    this._statblockEl = null;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Combat Tracker'; }
  getIcon()        { return 'swords'; }

  async onOpen() {
    this._setupLayout();
    await this.render();
  }

  _setupLayout() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('mt-root');
    this._headerEl    = root.createEl('div', { cls: 'mt-header' });
    this._entriesEl   = root.createEl('div', { cls: 'mt-entries' });
    this._statblockEl = root.createEl('div', { cls: 'mt-statblock-panel' });
  }

  async render() {
    if (!this._headerEl) return;
    this._renderHeader();
    await this._renderEntries();
  }

  // ── Header ──

  _renderHeader() {
    const hdr = this._headerEl;
    hdr.empty();

    const row1 = hdr.createEl('div', { cls: 'mt-hdr-row' });
    row1.createEl('span', { text: 'Combat Tracker', cls: 'mt-title' });

    const addGroup = row1.createEl('div', { cls: 'mt-btn-row' });

    const addBtn = addGroup.createEl('button', { cls: 'mt-btn mt-btn-add', title: 'Add mob or creature' });
    addBtn.createEl('span', { text: '+ Add' });
    addBtn.onclick = () => new AddEntryModal(this.app, this.plugin, () => this.render()).open();

    const playersBtn = addGroup.createEl('button', { cls: 'mt-btn mt-btn-players', title: 'Import party from vault player notes' });
    playersBtn.createEl('span', { text: '+ Players' });
    playersBtn.onclick = async () => {
      await this.plugin.addPlayers(this.app);
      this.render();
    };

    const pvBtn = addGroup.createEl('button', { cls: 'mt-btn mt-btn-pv', title: 'Open player view in popout window' });
    setIcon(pvBtn.createEl('span'), 'monitor');
    pvBtn.createEl('span', { text: ' Players' });
    pvBtn.onclick = () => this.plugin.openPlayerView();

    const row2 = hdr.createEl('div', { cls: 'mt-hdr-row mt-hdr-init' });

    const { round, currentTurnId, entries } = this.plugin.settings;
    const hasAnyEntry  = entries.length > 0;
    const hasInitiative = entries.some(e => e.initiative !== null);

    row2.createEl('span', {
      text: hasInitiative ? `Round ${round ?? 1}` : 'No initiative',
      cls: 'mt-round-label',
    });

    const initGroup = row2.createEl('div', { cls: 'mt-btn-row' });

    const rollBtn = initGroup.createEl('button', { cls: 'mt-btn mt-btn-roll', title: 'Roll initiative for all (skips those already set)' });
    rollBtn.createEl('span', { text: '🎲 Roll' });
    rollBtn.onclick = () => { this.plugin.rollAllInitiatives(); this.render(); };

    if (hasInitiative) {
      const nextBtn = initGroup.createEl('button', { cls: 'mt-btn mt-btn-next', title: 'Next turn' });
      nextBtn.createEl('span', { text: 'Next →' });
      nextBtn.onclick = () => { this.plugin.nextTurn(); this.render(); };

      const resetBtn = initGroup.createEl('button', { cls: 'mt-btn mt-btn-reset', title: 'Reset all initiatives' });
      resetBtn.createEl('span', { text: '↺' });
      resetBtn.onclick = () => { this.plugin.resetInitiatives(); this.render(); };
    }

    if (hasAnyEntry) {
      const clearBtn = initGroup.createEl('button', { cls: 'mt-btn mt-btn-clear', title: 'Remove all entries' });
      clearBtn.createEl('span', { text: 'Clear' });
      clearBtn.onclick = () => {
        this.plugin.settings.entries = [];
        this.plugin.settings.currentTurnId = null;
        this.plugin.settings.round = 1;
        this.plugin.save();
        this.activeStatblockId = null;
        this._statblockEl.empty();
        this.render();
      };
    }
  }

  // ── Entries ──

  async _renderEntries() {
    const el = this._entriesEl;
    el.empty();

    const { entries, currentTurnId } = this.plugin.settings;

    if (!entries.length) {
      el.createEl('p', { text: 'No entries. Add a mob, creature, or import players.', cls: 'mt-empty' });
      return;
    }

    const partyACs = entries
      .filter(e => e.type === 'player')
      .map(e => ({ name: e.name, ac: e.ac }));

    for (const entry of sortedByInitiative(entries)) {
      const isTurn = entry.id === currentTurnId;
      if      (entry.type === 'mob')        this._renderMob(el, entry, partyACs, isTurn);
      else if (entry.type === 'individual') this._renderIndividual(el, entry, partyACs, isTurn);
      else if (entry.type === 'player')     this._renderPlayer(el, entry, isTurn);
    }

    if (currentTurnId) {
      const activeCard = el.querySelector('.mt-current-turn');
      if (activeCard) activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ── Initiative chip ──

  _renderInitChip(container, entry) {
    const hasInit = entry.initiative !== null;
    const chip = container.createEl('span', {
      text: hasInit ? String(entry.initiative) : '—',
      cls: `mt-init-chip${hasInit ? ' init-has' : ' init-empty'}`,
      title: 'Click to set • dice to roll',
    });

    chip.onclick = e => {
      e.stopPropagation();
      let done = false;
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'mt-init-input';
      input.value = hasInit ? String(entry.initiative) : '';
      chip.replaceWith(input);
      input.focus();
      input.select();

      const commit = () => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        this.plugin.setInitiative(entry.id, v !== '' ? parseInt(v, 10) : null);
        this.render();
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') this.render();
      });
      input.addEventListener('blur', commit);
    };

    const dice = container.createEl('button', {
      cls: 'mt-btn mt-btn-dice',
      title: `Roll 1d20 + ${entry.initiativeModifier ?? 0}`,
    });
    setIcon(dice, 'dices');
    dice.onclick = e => {
      e.stopPropagation();
      this.plugin.setInitiative(entry.id, rollD20(entry.initiativeModifier ?? 0));
      this.render();
    };
  }

  // ── Mob card ──

  _renderMob(root, mob, partyACs, isTurn) {
    const alive      = mob.creatures.map((hp, i) => ({ hp, i })).filter(c => c.hp > 0);
    const aliveCount = alive.length;
    const isDead     = aliveCount === 0;
    const isActive   = this.activeStatblockId === mob.id;

    const card = root.createEl('div', {
      cls: `mt-card mt-mob${isDead ? ' mt-dead' : ''}${isTurn ? ' mt-current-turn' : ''}${isActive ? ' mt-active' : ''}`,
    });

    const head = card.createEl('div', { cls: 'mt-head' });
    const turnArrow = head.createEl('span', { cls: 'mt-turn-arrow' });
    if (isTurn) turnArrow.setText('▶');

    this._renderInitChip(head, mob);

    const nameEl = head.createEl('span', { text: mob.name, cls: 'mt-name mt-name-link' });
    nameEl.onclick = () => this.showStatblock(mob);

    const pct = aliveCount / mob.count;
    head.createEl('span', {
      text: ` [${aliveCount}/${mob.count}]`,
      cls: `mt-cnt ${isDead ? 'cnt-dead' : pct <= 0.5 ? 'cnt-low' : 'cnt-ok'}`,
    });
    head.createEl('span', { text: 'mob', cls: 'mt-badge mt-badge-mob' });

    const stats = card.createEl('div', { cls: 'mt-stats' });
    stats.createEl('span', { text: `HP ${mob.maxHp}` });
    stats.createEl('span', { text: `AC ${mob.ac}` });
    if (mob.attackBonus != null) stats.createEl('span', { text: `+${mob.attackBonus} atk` });
    if (mob.damage)              stats.createEl('span', { text: mob.damage });
    if (mob.cr)                  stats.createEl('span', { text: `CR ${mob.cr}` });

    const wounded = alive.filter(c => c.hp < mob.maxHp);
    if (wounded.length) {
      const row = card.createEl('div', { cls: 'mt-wounded' });
      row.createEl('span', { text: 'Wounded: ', cls: 'mt-label' });
      for (const { hp, i } of wounded) {
        row.createEl('span', {
          text: `#${i + 1}(${hp})`,
          cls: 'mt-chip mt-chip-wounded',
          title: `Creature ${i + 1}: ${hp}/${mob.maxHp} HP`,
        });
      }
    }

    if (mob.attackBonus != null && aliveCount > 0 && partyACs.length > 0) {
      const row = card.createEl('div', { cls: 'mt-atk-row' });
      row.createEl('span', { text: 'Hits vs: ', cls: 'mt-label' });
      for (const { name, ac } of partyACs) {
        const hits = calcHits(aliveCount, mob.attackBonus, ac);
        row.createEl('span', {
          text: `${name.split(' ')[0]} ${hits}`,
          cls: `mt-chip ${hits === 0 ? 'chip-zero' : hits <= 2 ? 'chip-low' : 'chip-high'}`,
          title: `${name} (AC ${ac}): ${hits} hit${hits !== 1 ? 's' : ''} from ${aliveCount} creatures`,
        });
      }
    }

    const actions = card.createEl('div', { cls: 'mt-actions' });
    if (!isDead) {
      const aoe = actions.createEl('button', { text: 'AoE', cls: 'mt-btn mt-btn-aoe' });
      aoe.onclick = () => new AoeDamageModal(this.app, mob, (dmg, n) => {
        this.plugin.applyAoeDamage(mob.id, dmg, n); this.render();
      }).open();

      const atk = actions.createEl('button', { text: 'Attack', cls: 'mt-btn mt-btn-atk' });
      atk.onclick = () => new AttackModal(this.app, mob, (dmg, idx) => {
        this.plugin.applyAttackDamage(mob.id, dmg, idx); this.render();
      }).open();

      const heal = actions.createEl('button', { text: 'Heal', cls: 'mt-btn mt-btn-heal' });
      heal.onclick = () => new MobHealModal(this.app, mob, amount => {
        this.plugin.applyMobHeal(mob.id, amount); this.render();
      }).open();
    } else {
      actions.createEl('span', { text: 'Defeated', cls: 'mt-defeated' });
    }

    const rem = actions.createEl('button', { text: '✕', cls: 'mt-btn mt-btn-rem', title: 'Remove' });
    rem.onclick = () => { this._removeEntry(mob.id); };
  }

  // ── Individual creature card ──

  _renderIndividual(root, entry, partyACs, isTurn) {
    const isDead   = entry.currentHp <= 0;
    const pct      = entry.currentHp / entry.maxHp;
    const isActive = this.activeStatblockId === entry.id;

    const card = root.createEl('div', {
      cls: `mt-card mt-individual${isDead ? ' mt-dead' : ''}${isTurn ? ' mt-current-turn' : ''}${isActive ? ' mt-active' : ''}`,
    });

    const head = card.createEl('div', { cls: 'mt-head' });
    const turnArrow = head.createEl('span', { cls: 'mt-turn-arrow' });
    if (isTurn) turnArrow.setText('▶');

    this._renderInitChip(head, entry);

    const nameEl = head.createEl('span', { text: entry.name, cls: 'mt-name mt-name-link' });
    nameEl.onclick = () => this.showStatblock(entry);

    head.createEl('span', {
      text: ` [${entry.currentHp}/${entry.maxHp}]`,
      cls: `mt-cnt ${isDead ? 'cnt-dead' : pct <= 0.5 ? 'cnt-low' : 'cnt-ok'}`,
    });
    head.createEl('span', { text: 'creature', cls: 'mt-badge mt-badge-ind' });

    const track = card.createEl('div', { cls: 'mt-hp-track' });
    const fill  = track.createEl('div', {
      cls: `mt-hp-fill ${isDead ? 'bar-dead' : pct <= 0.25 ? 'bar-crit' : pct <= 0.5 ? 'bar-low' : 'bar-ok'}`,
    });
    fill.style.width = `${Math.max(0, Math.min(100, pct * 100)).toFixed(1)}%`;

    const stats = card.createEl('div', { cls: 'mt-stats' });
    stats.createEl('span', { text: `AC ${entry.ac}` });
    if (entry.attackBonus != null) stats.createEl('span', { text: `+${entry.attackBonus} atk` });
    if (entry.damage)              stats.createEl('span', { text: entry.damage });
    if (entry.cr)                  stats.createEl('span', { text: `CR ${entry.cr}` });

    const actions = card.createEl('div', { cls: 'mt-actions' });
    if (!isDead) {
      const dmg = actions.createEl('button', { text: 'Damage', cls: 'mt-btn mt-btn-atk' });
      dmg.onclick = () => new IndDamageModal(this.app, entry, d => {
        this.plugin.applyIndDamage(entry.id, d); this.render();
      }).open();

      const heal = actions.createEl('button', { text: 'Heal', cls: 'mt-btn mt-btn-heal' });
      heal.onclick = () => new IndHealModal(this.app, entry, h => {
        this.plugin.applyIndHeal(entry.id, h); this.render();
      }).open();
    } else {
      actions.createEl('span', { text: 'Defeated', cls: 'mt-defeated' });
    }

    const rem = actions.createEl('button', { text: '✕', cls: 'mt-btn mt-btn-rem', title: 'Remove' });
    rem.onclick = () => { this._removeEntry(entry.id); };
  }

  // ── Player card ──

  _renderPlayer(root, entry, isTurn) {
    const isActive = this.activeStatblockId === entry.id;

    const card = root.createEl('div', {
      cls: `mt-card mt-player${isTurn ? ' mt-current-turn' : ''}${isActive ? ' mt-active' : ''}`,
    });

    const head = card.createEl('div', { cls: 'mt-head' });
    const turnArrow = head.createEl('span', { cls: 'mt-turn-arrow' });
    if (isTurn) turnArrow.setText('▶');

    this._renderInitChip(head, entry);

    const nameEl = head.createEl('span', { text: entry.name, cls: 'mt-name mt-name-link' });
    nameEl.onclick = () => {
      if (entry.bestiaryPath) {
        const file = this.app.vault.getAbstractFileByPath(entry.bestiaryPath);
        if (file) this.app.workspace.getLeaf(false).openFile(file);
      }
    };

    head.createEl('span', { text: `AC ${entry.ac}`, cls: 'mt-cnt cnt-ok' });
    head.createEl('span', { text: 'player', cls: 'mt-badge mt-badge-player' });

    const actions = card.createEl('div', { cls: 'mt-actions' });
    const rem = actions.createEl('button', { text: '✕', cls: 'mt-btn mt-btn-rem', title: 'Remove' });
    rem.onclick = () => { this._removeEntry(entry.id); };
  }

  _removeEntry(id) {
    if (this.activeStatblockId === id) {
      this.activeStatblockId = null;
      this._statblockEl.empty();
    }
    this.plugin.remove(id);
    this.render();
  }

  // ── Statblock panel ──

  async showStatblock(entry) {
    const panel = this._statblockEl;

    if (this.activeStatblockId === entry.id) {
      this.activeStatblockId = null;
      panel.empty();
      return;
    }

    this.activeStatblockId = entry.id;
    panel.empty();

    let file = entry.bestiaryPath
      ? this.app.vault.getAbstractFileByPath(entry.bestiaryPath)
      : null;
    if (!file) {
      const indexed = this.plugin.bestiary.get(entry.name.toLowerCase());
      if (indexed?.path) file = this.app.vault.getAbstractFileByPath(indexed.path);
    }

    const hdr = panel.createEl('div', { cls: 'mt-sb-hdr' });
    hdr.createEl('span', { text: entry.name, cls: 'mt-sb-title' });
    const closeBtn = hdr.createEl('button', { text: '✕', cls: 'mt-btn mt-btn-rem' });
    closeBtn.onclick = () => { this.activeStatblockId = null; panel.empty(); };

    if (!file) {
      panel.createEl('p', { text: `No bestiary entry for "${entry.name}".`, cls: 'mt-sb-missing' });
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const blockMatch = /```statblock[\s\S]*?```/.exec(content);
    if (!blockMatch) {
      panel.createEl('p', { text: 'No statblock found in file.', cls: 'mt-sb-missing' });
      return;
    }

    await MarkdownRenderer.render(this.app, blockMatch[0], panel.createDiv('markdown-rendered'), file.path, this);
  }
}

// ──────────────────────────── Add Entry Modal ──────────────────────────────────

class AddEntryModal extends Modal {
  constructor(app, plugin, onDone) {
    super(app);
    this.plugin  = plugin;
    this.onDone  = onDone;

    this.entryType          = 'individual';
    this.name               = '';
    this.count              = 1;
    this.maxHp              = 1;
    this.ac                 = 10;
    this.attackBonus        = null;
    this.damage             = '';
    this.cr                 = null;
    this.bestiaryPath       = null;
    this.initiativeModifier = 0;

    this._nameEl  = null;
    this._hpComp  = null;
    this._acComp  = null;
    this._atkComp = null;
    this._dmgComp = null;
    this._suggestEl = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('mt-modal');
    contentEl.createEl('h3', { text: 'Add to Encounter', cls: 'mt-modal-title' });

    const toggleRow = contentEl.createEl('div', { cls: 'mt-toggle-row' });
    this._mobBtn = toggleRow.createEl('button', { text: 'Mob', cls: 'mt-toggle-btn' });
    this._indBtn = toggleRow.createEl('button', { text: 'Individual', cls: 'mt-toggle-btn mt-toggle-on' });
    this._mobBtn.onclick = () => this._setType('mob');
    this._indBtn.onclick = () => this._setType('individual');

    this._formEl = contentEl.createEl('div', { cls: 'mt-modal-form' });
    this._renderForm();
  }

  _setType(t) {
    this.entryType = t;
    this._mobBtn.toggleClass('mt-toggle-on', t === 'mob');
    this._indBtn.toggleClass('mt-toggle-on', t === 'individual');
    this._formEl.empty();
    this._renderForm();
  }

  _renderForm() {
    const el = this._formEl;
    const isMob = this.entryType === 'mob';

    new Setting(el).setName('Name').addText(t => {
      this._nameEl = t.inputEl;
      t.setPlaceholder('e.g., Goblin Warrior');
      t.setValue(this.name);
      t.onChange(v => { this.name = v; this._updateSuggestions(v); });
    });

    this._suggestEl = el.createEl('div', { cls: 'mt-suggest' });
    this._suggestEl.style.display = 'none';

    if (isMob) {
      new Setting(el).setName('Creature Count').addText(t => {
        t.inputEl.type = 'number';
        t.setPlaceholder('e.g., 8');
        t.setValue(String(this.count));
        t.onChange(v => this.count = Math.max(1, +v || 1));
      });
    }

    new Setting(el).setName(isMob ? 'HP per creature' : 'Max HP').addText(t => {
      this._hpComp = t;
      t.inputEl.type = 'number';
      t.setValue(String(this.maxHp));
      t.onChange(v => this.maxHp = Math.max(1, +v || 1));
    });

    new Setting(el).setName('AC').addText(t => {
      this._acComp = t;
      t.inputEl.type = 'number';
      t.setValue(String(this.ac));
      t.onChange(v => this.ac = Math.max(1, +v || 10));
    });

    new Setting(el).setName('Attack Bonus (optional)').addText(t => {
      this._atkComp = t;
      t.inputEl.type = 'number';
      t.setPlaceholder('e.g., 4');
      if (this.attackBonus != null) t.setValue(String(this.attackBonus));
      t.onChange(v => this.attackBonus = v.trim() !== '' ? (+v ?? null) : null);
    });

    new Setting(el).setName('Damage (optional)').addText(t => {
      this._dmgComp = t;
      t.setPlaceholder('e.g., 2d6 + 3');
      t.setValue(this.damage ?? '');
      t.onChange(v => this.damage = v.trim());
    });

    new Setting(el).addButton(btn =>
      btn.setButtonText(isMob ? 'Add Mob' : 'Add Creature').setCta().onClick(() => this._submit())
    );
  }

  _updateSuggestions(query) {
    const box = this._suggestEl;
    if (!box) return;
    if (!query || query.length < 2) { box.style.display = 'none'; return; }
    if (!this.plugin.bestiary?.size) {
      box.empty(); box.style.display = 'block';
      box.createEl('div', { text: 'Building bestiary index…', cls: 'mt-suggest-loading' });
      return;
    }

    const q = query.toLowerCase();
    const results = [];
    for (const [key, c] of this.plugin.bestiary) {
      if (key.includes(q)) results.push(c);
      if (results.length >= 10) break;
    }
    results.sort((a, b) => {
      const aP = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bP = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aP - bP || a.name.localeCompare(b.name);
    });

    box.empty();
    if (!results.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    for (const c of results) {
      const item = box.createEl('div', { cls: 'mt-suggest-item' });
      item.createEl('span', { text: c.name, cls: 'mt-suggest-name' });
      item.createEl('span', {
        text: `HP ${c.hp} · AC ${c.ac}${c.attackBonus != null ? ` · +${c.attackBonus} atk` : ''}${c.cr ? ` · CR ${c.cr}` : ''}`,
        cls: 'mt-suggest-meta',
      });
      item.onmousedown = e => { e.preventDefault(); this._fillFromBestiary(c); };
    }
  }

  _fillFromBestiary(c) {
    this.name               = c.name;
    this.maxHp              = c.hp;
    this.ac                 = c.ac;
    this.attackBonus        = c.attackBonus;
    this.damage             = c.damage ?? '';
    this.cr                 = c.cr;
    this.bestiaryPath       = c.path ?? null;
    this.initiativeModifier = c.initiativeModifier ?? 0;

    if (this._nameEl)  this._nameEl.value = c.name;
    if (this._hpComp)  this._hpComp.setValue(String(c.hp));
    if (this._acComp)  this._acComp.setValue(String(c.ac));
    if (this._atkComp) this._atkComp.setValue(c.attackBonus != null ? String(c.attackBonus) : '');
    if (this._dmgComp) this._dmgComp.setValue(c.damage ?? '');
    if (this._suggestEl) this._suggestEl.style.display = 'none';
  }

  _submit() {
    if (!this.name.trim()) return;
    const base = {
      id: uid(),
      name: this.name.trim(),
      initiative: null,
      initiativeModifier: this.initiativeModifier ?? 0,
      ac: this.ac,
      attackBonus: this.attackBonus,
      damage: this.damage || null,
      cr: this.cr,
      bestiaryPath: this.bestiaryPath,
    };

    if (this.entryType === 'mob') {
      this.plugin.addEntry({ ...base, type: 'mob', count: this.count, creatures: Array(this.count).fill(this.maxHp), maxHp: this.maxHp });
    } else {
      this.plugin.addEntry({ ...base, type: 'individual', currentHp: this.maxHp, maxHp: this.maxHp });
    }
    this.onDone();
    this.close();
  }

  onClose() { this.contentEl.empty(); }
}

// ──────────────────────────── Damage / Heal Modals ────────────────────────────

class AoeDamageModal extends Modal {
  constructor(app, mob, onSubmit) { super(app); this.mob = mob; this.onSubmit = onSubmit; }
  onOpen() {
    const { contentEl } = this;
    const aliveCount = this.mob.creatures.filter(hp => hp > 0).length;
    contentEl.createEl('h3', { text: `AoE — ${this.mob.name}` });
    contentEl.createEl('p', { text: `${aliveCount} alive. Each failing creature takes the damage individually — no rollover.`, cls: 'mt-modal-desc' });
    let dmg = 0, n = aliveCount;
    new Setting(contentEl).setName('Damage per creature').addText(t => { t.inputEl.type = 'number'; t.onChange(v => dmg = Math.max(0, +v || 0)); });
    new Setting(contentEl).setName(`Creatures failing save (max ${aliveCount})`).addText(t => { t.inputEl.type = 'number'; t.setValue(String(aliveCount)); t.onChange(v => n = Math.min(aliveCount, Math.max(0, +v || 0))); });
    new Setting(contentEl).addButton(btn => btn.setButtonText('Apply AoE').setCta().onClick(() => { this.onSubmit(dmg, n); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class AttackModal extends Modal {
  constructor(app, mob, onSubmit) { super(app); this.mob = mob; this.onSubmit = onSubmit; }
  onOpen() {
    const { contentEl } = this;
    const alive = this.mob.creatures.map((hp, i) => ({ hp, i })).filter(c => c.hp > 0);
    const def = alive.reduce((w, c) => c.hp < w.hp ? c : w, alive[0]);
    contentEl.createEl('h3', { text: `Attack — ${this.mob.name}` });
    contentEl.createEl('p', { text: `Damage accumulates on the target only. At ${this.mob.maxHp} total, that creature is eliminated.`, cls: 'mt-modal-desc' });
    let dmg = 0, idx = def?.i ?? 0;
    new Setting(contentEl).setName('Damage').addText(t => { t.inputEl.type = 'number'; t.onChange(v => dmg = Math.max(0, +v || 0)); });
    if (alive.length === 1) {
      contentEl.createEl('p', { text: `Targeting Creature ${alive[0].i + 1} — ${alive[0].hp}/${this.mob.maxHp} HP`, cls: 'mt-modal-desc' });
    } else {
      new Setting(contentEl).setName('Target').addDropdown(dd => {
        for (const { hp, i } of alive) dd.addOption(String(i), `Creature ${i + 1} — ${hp}/${this.mob.maxHp} HP${hp < this.mob.maxHp ? ' ★' : ''}`);
        dd.setValue(String(def?.i ?? 0));
        dd.onChange(v => idx = +v);
      });
    }
    new Setting(contentEl).addButton(btn => btn.setButtonText('Apply Attack').setCta().onClick(() => { this.onSubmit(dmg, idx); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class MobHealModal extends Modal {
  constructor(app, mob, onSubmit) { super(app); this.mob = mob; this.onSubmit = onSubmit; }
  onOpen() {
    const { contentEl } = this;
    const aliveCount = this.mob.creatures.filter(hp => hp > 0).length;
    contentEl.createEl('h3', { text: `Heal — ${this.mob.name}` });
    contentEl.createEl('p', { text: `Restores HP to all ${aliveCount} alive creature${aliveCount !== 1 ? 's' : ''}, up to ${this.mob.maxHp} each.`, cls: 'mt-modal-desc' });
    let amount = 0;
    new Setting(contentEl).setName('HP to restore (per creature)').addText(t => { t.inputEl.type = 'number'; t.onChange(v => amount = Math.max(0, +v || 0)); });
    new Setting(contentEl).addButton(btn => btn.setButtonText('Apply Heal').onClick(() => { this.onSubmit(amount); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class IndDamageModal extends Modal {
  constructor(app, entry, onSubmit) { super(app); this.entry = entry; this.onSubmit = onSubmit; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `Damage — ${this.entry.name}` });
    contentEl.createEl('p', { text: `Current HP: ${this.entry.currentHp} / ${this.entry.maxHp}`, cls: 'mt-modal-desc' });
    let dmg = 0;
    new Setting(contentEl).setName('Damage').addText(t => { t.inputEl.type = 'number'; t.onChange(v => dmg = Math.max(0, +v || 0)); });
    new Setting(contentEl).addButton(btn => btn.setButtonText('Apply Damage').setCta().onClick(() => { this.onSubmit(dmg); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class IndHealModal extends Modal {
  constructor(app, entry, onSubmit) { super(app); this.entry = entry; this.onSubmit = onSubmit; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `Heal — ${this.entry.name}` });
    contentEl.createEl('p', { text: `Current HP: ${this.entry.currentHp} / ${this.entry.maxHp}`, cls: 'mt-modal-desc' });
    let hp = 0;
    new Setting(contentEl).setName('HP to restore').addText(t => { t.inputEl.type = 'number'; t.onChange(v => hp = Math.max(0, +v || 0)); });
    new Setting(contentEl).addButton(btn => btn.setButtonText('Apply Heal').onClick(() => { this.onSubmit(hp); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}

// ──────────────────────────── Player View ─────────────────────────────────────

function hpStatus(currentHp, maxHp) {
  if (currentHp <= 0)               return { label: 'Defeated',  cls: 'pv-defeated' };
  const pct = currentHp / maxHp;
  if (pct > 0.75)                   return { label: 'Healthy',   cls: 'pv-healthy'  };
  if (pct > 0.50)                   return { label: 'Wounded',   cls: 'pv-wounded'  };
  if (pct > 0.25)                   return { label: 'Bloodied',  cls: 'pv-bloodied' };
  return                                   { label: 'Critical',  cls: 'pv-critical' };
}

function mobStatus(aliveCount, totalCount) {
  if (aliveCount === 0)             return { label: 'Defeated',           cls: 'pv-defeated' };
  const pct = aliveCount / totalCount;
  if (pct > 0.75)                   return { label: `${aliveCount} alive`, cls: 'pv-healthy'  };
  if (pct > 0.50)                   return { label: `${aliveCount} alive`, cls: 'pv-wounded'  };
  if (pct > 0.25)                   return { label: `${aliveCount} alive`, cls: 'pv-bloodied' };
  return                                   { label: `${aliveCount} alive`, cls: 'pv-critical' };
}

class PlayerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return PLAYER_VIEW_TYPE; }
  getDisplayText() { return 'Players — Combat Tracker'; }
  getIcon()        { return 'swords'; }

  async onOpen() { this.render(); }

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('pv-root');

    const { entries, round, currentTurnId } = this.plugin.settings;
    const sorted      = sortedByInitiative(entries);
    const hasInit     = sorted.some(e => e.initiative !== null);
    const activeIdx   = sorted.findIndex(e => e.id === currentTurnId);
    const activeEntry = activeIdx >= 0 ? sorted[activeIdx] : null;
    const nextEntry   = activeIdx >= 0 ? sorted[(activeIdx + 1) % sorted.length] : null;

    const banner = root.createEl('div', { cls: 'pv-banner' });
    banner.createEl('span', {
      text: hasInit ? `Round ${round ?? 1}` : 'Combat Tracker',
      cls: 'pv-round',
    });

    if (!sorted.length) {
      root.createEl('p', { text: 'Waiting for encounter to begin…', cls: 'pv-waiting' });
      return;
    }

    if (activeEntry) {
      const spotlight = root.createEl('div', { cls: 'pv-spotlight' });

      if (activeEntry.type === 'player') {
        spotlight.addClass('pv-spotlight-player');
        spotlight.createEl('div', { text: "Player's Turn", cls: 'pv-spotlight-label' });
        spotlight.createEl('div', { text: activeEntry.name, cls: 'pv-spotlight-name' });
      } else {
        spotlight.addClass('pv-spotlight-monster');

        const imgArea = spotlight.createEl('div', { cls: 'pv-img-area' });
        const info    = spotlight.createEl('div', { cls: 'pv-spotlight-info' });
        info.createEl('div', { text: activeEntry.name, cls: 'pv-spotlight-name' });

        if (activeEntry.type === 'mob') {
          const alive = activeEntry.creatures.filter(hp => hp > 0).length;
          const st = mobStatus(alive, activeEntry.count);
          info.createEl('span', { text: `${st.label} / ${activeEntry.count}`, cls: `pv-pill ${st.cls}` });
        } else {
          const st = hpStatus(activeEntry.currentHp, activeEntry.maxHp);
          info.createEl('span', { text: st.label, cls: `pv-pill ${st.cls}` });
        }

        findCreatureImage(this.app, activeEntry).then(url => {
          if (url) {
            imgArea.addClass('pv-img-loaded');
            imgArea.createEl('img', { cls: 'pv-creature-img', attr: { src: url } });
          } else {
            imgArea.addClass('pv-img-empty');
          }
        });
      }
    }

    const list = root.createEl('div', { cls: 'pv-list' });

    for (const entry of sorted) {
      const isTurn  = entry.id === currentTurnId;
      const isNext  = !isTurn && nextEntry && entry.id === nextEntry.id;
      const row     = list.createEl('div', { cls: `pv-row${isTurn ? ' pv-active' : ''}${isNext ? ' pv-ondeck' : ''}` });

      const initEl = row.createEl('div', { cls: 'pv-init' });
      initEl.createEl('span', {
        text: entry.initiative !== null ? String(entry.initiative) : '—',
        cls: 'pv-init-val',
      });

      const nameEl = row.createEl('div', { cls: 'pv-name' });
      if (isTurn)       nameEl.createEl('span', { text: 'ACTIVE',  cls: 'pv-turn-badge pv-badge-active' });
      else if (isNext)  nameEl.createEl('span', { text: 'ON DECK', cls: 'pv-turn-badge pv-badge-ondeck' });
      nameEl.createEl('span', { text: entry.name });

      const pillEl = row.createEl('div', { cls: 'pv-status' });
      if (entry.type === 'player') {
        pillEl.createEl('span', { text: 'Player', cls: 'pv-pill pv-player' });
      } else if (entry.type === 'mob') {
        const alive = entry.creatures.filter(hp => hp > 0).length;
        const st = mobStatus(alive, entry.count);
        pillEl.createEl('span', { text: `${st.label} / ${entry.count}`, cls: `pv-pill ${st.cls}` });
      } else if (entry.type === 'individual') {
        const st = hpStatus(entry.currentHp, entry.maxHp);
        pillEl.createEl('span', { text: st.label, cls: `pv-pill ${st.cls}` });
      }
    }
  }
}

// ──────────────────────────── Settings Tab ────────────────────────────────────

class CombatTrackerSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Combat Tracker' });

    new Setting(containerEl)
      .setName('Bestiary paths')
      .setDesc('Vault folders to scan for creature statblock files (one path per line). Used for name autocomplete and stat population when adding creatures. Requires the obsidian-5e-statblocks plugin or markdown files containing ```statblock``` code blocks.')
      .addTextArea(text => {
        text
          .setPlaceholder('3-Mechanics/CLI/compendium/bestiary\n3-Homebrew/Beasts')
          .setValue((this.plugin.settings.bestiaryPaths ?? []).join('\n'));
        text.inputEl.rows = 6;
        text.inputEl.style.width = '100%';
        text.inputEl.addEventListener('blur', async () => {
          this.plugin.settings.bestiaryPaths = text.getValue()
            .split('\n').map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
          this.plugin.bestiary = await buildBestiary(this.app, this.plugin.settings.bestiaryPaths);
          console.log(`[Combat Tracker] Bestiary rebuilt: ${this.plugin.bestiary.size} creatures`);
        });
      });

    new Setting(containerEl)
      .setName('Party folder')
      .setDesc('Vault folder containing player character notes. Files with Role: Player and Status: Active are imported when you click + Players.')
      .addText(text => text
        .setPlaceholder('1-Party/ChaosMonkeys')
        .setValue(this.plugin.settings.partyFolder ?? '')
        .onChange(async val => {
          this.plugin.settings.partyFolder = val.trim();
          await this.plugin.saveSettings();
        }));
  }
}

// ──────────────────────────── Plugin ──────────────────────────────────────────

class CombatTrackerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.bestiary = new Map();

    this.registerView(VIEW_TYPE,        leaf => new CombatTrackerView(leaf, this));
    this.registerView(PLAYER_VIEW_TYPE, leaf => new PlayerView(leaf, this));

    this.addSettingTab(new CombatTrackerSettingsTab(this.app, this));

    this.addRibbonIcon('swords', 'Combat Tracker', () => this.openView());
    this.addCommand({ id: 'open-combat-tracker', name: 'Open Combat Tracker', callback: () => this.openView() });
    this.addCommand({ id: 'open-player-view',    name: 'Open Player View (popout)', callback: () => this.openPlayerView() });

    buildBestiary(this.app, this.settings.bestiaryPaths).then(idx => {
      this.bestiary = idx;
      console.log(`[Combat Tracker] Bestiary ready: ${idx.size} creatures`);
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(PLAYER_VIEW_TYPE);
  }

  async openView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async openPlayerView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(PLAYER_VIEW_TYPE)[0];
    if (existing) { workspace.revealLeaf(existing); return; }
    const leaf = workspace.openPopoutLeaf();
    await leaf.setViewState({ type: PLAYER_VIEW_TYPE, active: true });
  }

  // ── Entry management ──

  addEntry(entry) { this.settings.entries.push(entry); this.save(); }

  remove(id) {
    this.settings.entries = this.settings.entries.filter(e => e.id !== id);
    if (this.settings.currentTurnId === id) this.settings.currentTurnId = null;
    this.save();
  }

  async addPlayers(app) {
    const players = await loadPlayersFromVault(app ?? this.app, this.settings.partyFolder);
    const existing = new Set(this.settings.entries.map(e => e.name));
    let added = 0;
    for (const p of players) {
      if (!existing.has(p.name)) { this.settings.entries.push(p); added++; }
    }
    if (added) this.save();
  }

  // ── Initiative ──

  rollAllInitiatives() {
    for (const e of this.settings.entries) {
      if (e.initiative === null)
        e.initiative = rollD20(e.initiativeModifier ?? 0);
    }
    if (!this.settings.currentTurnId) {
      const first = sortedByInitiative(this.settings.entries)[0];
      if (first) this.settings.currentTurnId = first.id;
    }
    if (!this.settings.round) this.settings.round = 1;
    this.save();
  }

  nextTurn() {
    const ordered = sortedByInitiative(this.settings.entries)
      .filter(e => e.initiative !== null);
    if (!ordered.length) return;

    if (!this.settings.currentTurnId) {
      this.settings.currentTurnId = ordered[0].id;
      this.settings.round = 1;
    } else {
      const idx = ordered.findIndex(e => e.id === this.settings.currentTurnId);
      const next = idx + 1;
      if (next >= ordered.length) {
        this.settings.round = (this.settings.round ?? 1) + 1;
        this.settings.currentTurnId = ordered[0].id;
      } else {
        this.settings.currentTurnId = ordered[next].id;
      }
    }
    this.save();
  }

  setInitiative(id, value) {
    const e = this.settings.entries.find(e => e.id === id);
    if (!e) return;
    e.initiative = value;
    this.save();
  }

  resetInitiatives() {
    for (const e of this.settings.entries) e.initiative = null;
    this.settings.currentTurnId = null;
    this.settings.round = 1;
    this.save();
  }

  // ── Damage / Heal ──

  applyAoeDamage(id, damage, failCount) {
    const mob = this.settings.entries.find(e => e.id === id);
    if (!mob || damage <= 0) return;
    let hit = 0;
    for (let i = 0; i < mob.creatures.length && hit < failCount; i++) {
      if (mob.creatures[i] > 0) { mob.creatures[i] = Math.max(0, mob.creatures[i] - damage); hit++; }
    }
    this.save();
  }

  applyAttackDamage(id, damage, targetIdx) {
    const mob = this.settings.entries.find(e => e.id === id);
    if (!mob || damage <= 0) return;
    if (mob.creatures[targetIdx] > 0)
      mob.creatures[targetIdx] = Math.max(0, mob.creatures[targetIdx] - damage);
    this.save();
  }

  applyMobHeal(id, amount) {
    const mob = this.settings.entries.find(e => e.id === id);
    if (!mob || amount <= 0) return;
    for (let i = 0; i < mob.creatures.length; i++) {
      if (mob.creatures[i] > 0) mob.creatures[i] = Math.min(mob.maxHp, mob.creatures[i] + amount);
    }
    this.save();
  }

  applyIndDamage(id, damage) {
    const e = this.settings.entries.find(e => e.id === id);
    if (!e || damage <= 0) return;
    e.currentHp = Math.max(0, e.currentHp - damage);
    this.save();
  }

  applyIndHeal(id, hp) {
    const e = this.settings.entries.find(e => e.id === id);
    if (!e || hp <= 0) return;
    e.currentHp = Math.min(e.maxHp, e.currentHp + hp);
    this.save();
  }

  // ── Settings ──

  async loadSettings() {
    const raw = await this.loadData() ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...raw };
    // Ensure array fields exist after merge
    if (!Array.isArray(this.settings.entries))      this.settings.entries = [];
    if (!Array.isArray(this.settings.bestiaryPaths)) this.settings.bestiaryPaths = [...DEFAULT_BESTIARY_PATHS];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  save() {
    this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(PLAYER_VIEW_TYPE)) {
      leaf.view.render?.();
    }
  }
}

module.exports = CombatTrackerPlugin;
