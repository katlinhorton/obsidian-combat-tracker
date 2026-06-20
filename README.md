# Combat Tracker

A D&D 5e encounter tracker for Obsidian. Tracks initiative order, mob HP (per-creature), and individual monsters in a single sidebar pane. Autocompletes stats from your bestiary vault files and includes a full-screen player-facing popout display for a second monitor.

---

## Features

- Initiative rolling and turn tracking with round counter
- Auto-import party members from your player character notes in the vault
- Mob tracking with per-creature HP — AoE and attack damage handled separately, no HP rollover between creatures
- Individual creature tracking with HP bar
- Bestiary autocomplete — name autocomplete fills HP, AC, attack bonus, damage, and initiative modifier from your vault files
- Inline statblock viewer — click any creature name to render its statblock in the same pane
- Player view popout — a second OS window for a second monitor showing initiative order and creature images

---

## Opening the Tracker

Click the **swords icon** in the left ribbon, or run the command `Combat Tracker: Open Combat Tracker`.

---

## Adding Creatures

Click **+ Add** in the tracker header.

1. **Choose type** — Individual (default) or Mob using the toggle at the top of the modal.
2. **Type a name** — after 2 characters, an autocomplete list appears pulling from your bestiary. Selecting a suggestion fills HP, AC, attack bonus, damage, CR, and initiative modifier automatically.
3. **Adjust fields** as needed, then click **Add Creature** or **Add Mob**.

### Individual vs. Mob

| | Individual | Mob |
|---|---|---|
| HP tracking | Single HP pool with bar | Per-creature HP array |
| Damage types | Damage / Heal | AoE / Attack / Heal |
| Count display | `[currentHp/maxHp]` | `[alive/total]` |

---

## Initiative

### Adding Players

Click **+ Players** to import your party from the folder configured in plugin settings (default: `1-Party/ChaosMonkeys`). Any note in that folder with `Role: Player` and `Status: Active` in its frontmatter is imported. Players already present in the tracker are skipped.

To change the party folder, go to **Settings → Combat Tracker → Party folder**.

### Rolling Initiative

- **🎲 Roll** — rolls `1d20 + initiative modifier` for every entry that does not already have a value set. Does not overwrite existing values.
- **Dice button** on each card — re-rolls initiative for that one creature only.
- **Click the initiative chip** (the number or `—` on the left of each card) to type a value directly.

### Tracking Turns

Once any initiative is set, the header shows the current round and two new controls:

- **Next →** — advances to the next entry in initiative order (highest to lowest). Wraps at the end of the list and increments the round counter.
- **↺** — resets all initiative values and the round counter back to 1.

The active entry is highlighted with an accent border and an **ACTIVE** badge. The next entry in order shows an **ON DECK** badge.

### Sort Order

Entries are sorted highest initiative first. Ties are broken by: players before monsters, then higher initiative modifier.

---

## Damage and Healing

### Mobs

- **AoE** — enter damage and how many creatures failed the save. Each failing creature takes the full damage independently. Damage does **not** roll over between creatures.
- **Attack** — select a target creature from a dropdown (defaults to the most-wounded alive creature) and enter damage. Accumulates on that creature only; when it reaches max HP it is eliminated.
- **Heal** — restores HP to all alive creatures in the mob up to their max HP.

Wounded creatures (HP below max) are shown as chips below the mob card so you can track which creatures are hurt.

The **attack reference table** on each mob card shows how many hits land against each party member's AC given the current alive count. This updates automatically as creatures are eliminated.

### Individual Creatures

- **Damage** — subtracts from current HP, minimum 0.
- **Heal** — restores HP up to max.

---

## Statblock Viewer

Click any creature or mob **name** to render its statblock inline below the entry list in the same sidebar pane. Click the name again (or the ✕ button) to close it.

The viewer looks up the vault file stored during autocomplete. If no file path is available it searches the bestiary index by name.

---

## Player View (Second Monitor)

Click the **monitor icon → Players** button in the tracker header, or run the command `Combat Tracker: Open Player View (popout)`.

This opens a separate OS window you can drag to a second monitor or projector. It shows:

- **Round number** in a large banner at the top
- **Creature spotlight** — when it is a monster's or mob's turn, the creature's image (pulled from the bestiary file) fills the upper portion of the screen with its name and condition below. When it is a player's turn, a large "Player's Turn" panel with the player's name is shown instead.
- **Initiative list** — all entries sorted by initiative, with the active turn highlighted and marked **ACTIVE** and the next entry marked **ON DECK**.

**Creature conditions shown to players** (no exact HP numbers):

| Condition | HP remaining |
|---|---|
| Healthy | > 75% |
| Wounded | 51–75% |
| Bloodied | 26–50% |
| Critical | 1–25% |
| Defeated | 0 |

For mobs, the alive count is shown (e.g. `8 alive / 12`).

The player view updates automatically whenever the DM applies damage, heals, or advances the turn.

---

## Removing Entries

Click the **✕** button on any card to remove that entry from the encounter. Removing the currently active entry clears the active turn.

Click **Clear** in the header to remove all entries and reset the round counter.

---

## Bestiary Integration

The plugin reads creature stats from two sources (tried in order):

1. **obsidian-5e-statblocks plugin** — uses its in-memory bestiary if loaded.
2. **Vault markdown files** — scans `3-Mechanics/CLI/compendium/bestiary` and `3-Homebrew/Beasts` for files containing a `statblock` code block.

The bestiary index is built in the background when the plugin loads. The autocomplete shows a loading message if you type before it finishes.

Images in the player view spotlight are pulled from the creature's vault file — either the `image:` field in the statblock YAML or any `![[filename.png]]` embed in the file body.

---

## Requirements

- Obsidian 0.15.0 or later

### Optional integrations

- [obsidian-5e-statblocks](https://github.com/javalent/fantasy-statblocks) — speeds up bestiary loading if already installed; the plugin falls back to scanning vault files directly without it
