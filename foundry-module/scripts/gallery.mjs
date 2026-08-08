import {assignArtwork, createActorFromArtwork} from "./actor-art.mjs";
import {collectTagGroups, MODULE_ID} from "./catalog.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

export class FantasyGalleryApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(catalog, options = {}) {
    super(options);
    this.catalog = catalog;
    this.database = new Map(catalog.images.map((entry) => [entry.id, entry]));
    this.tagGroups = collectTagGroups(catalog.images);
  }

  catalog;
  database;
  tagGroups;
  filters = new Map();
  searchQuery = "";
  session = {selectedId: null, targetActorId: null};

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-gallery`,
    classes: ["fantasy-image-catalog"],
    window: {
      icon: "fa-solid fa-images",
      title: "FIC.Title",
      frame: true,
      resizable: true
    },
    position: {width: 1180, height: 760},
    actions: {
      assignPortrait: FantasyGalleryApplication.#assignPortrait,
      assignPortraitToken: FantasyGalleryApplication.#assignPortraitToken,
      clearFilters: FantasyGalleryApplication.#clearFilters,
      createActor: FantasyGalleryApplication.#createActor,
      inspectImage: FantasyGalleryApplication.#inspectImage,
      selectImage: FantasyGalleryApplication.#selectImage,
      toggleTag: FantasyGalleryApplication.#toggleTag
    }
  };

  static PARTS = {
    search: {template: `modules/${MODULE_ID}/templates/search.hbs`},
    tags: {template: `modules/${MODULE_ID}/templates/tags.hbs`},
    grid: {template: `modules/${MODULE_ID}/templates/grid.hbs`},
    details: {template: `modules/${MODULE_ID}/templates/details.hbs`}
  };

  get userHasAccess() {
    return game.user.isGM || game.user.hasRole(game.settings.get(MODULE_ID, "galleryAccess"));
  }

  setTarget(actor) {
    this.session.targetActorId = actor?.id ?? null;
    return this;
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const selected = this.database.get(this.session.selectedId) ?? null;
    const actors = game.actors
      .filter((actor) => actor.canUserModify(game.user, "update"))
      .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang))
      .map((actor) => ({id: actor.id, name: actor.name, img: actor.img, selected: actor.id === this.session.targetActorId}));
    const targetActor = game.actors.get(this.session.targetActorId) ?? null;
    const displayData = [...this.database.values()].map((entry) => ({
      ...entry,
      searchText: [entry.filename, entry.caption, ...Object.values(entry.tags ?? {}).flat()].join(" ").toLocaleLowerCase(game.i18n.lang),
      flatTags: Object.entries(entry.tags ?? {}).flatMap(([category, tags]) => tags.map((tag) => `${category}:${tag}`)).join("|")
    }));
    return {
      ...context,
      selected,
      targetActor,
      actors,
      displayData,
      tagGroups: this.tagGroups,
      imageCount: displayData.length,
      canCreate: game.user.isGM,
      catalogVersion: this.catalog.taxonomyVersion
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if (options.parts.includes("search")) {
      const input = this.parts.search.querySelector("input[type=search]");
      input.value = this.searchQuery;
      input.addEventListener("input", () => {
        this.searchQuery = input.value.trim().toLocaleLowerCase(game.i18n.lang);
        this.#updateGrid();
      });
    }
    if (options.parts.includes("tags")) {
      for (const button of this.parts.tags.querySelectorAll("button[data-tag]")) {
        const key = `${button.dataset.category}:${button.dataset.tag}`;
        const state = this.filters.get(key) ?? null;
        button.classList.toggle("include", state === "include");
        button.classList.toggle("exclude", state === "exclude");
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          this.#advanceTag(button, "backward");
        });
      }
    }
    if (options.parts.includes("details")) {
      this.parts.details.querySelector("select[name=targetActor]")?.addEventListener("change", (event) => {
        this.session.targetActorId = event.currentTarget.value || null;
        this.render({parts: ["details"]});
      });
    }
    if (options.parts.includes("grid")) this.#updateGrid();
  }

  #updateGrid() {
    const grid = this.parts.grid?.querySelector(".fic-grid");
    if (!grid) return;
    const grouped = new Map();
    for (const [key, state] of this.filters) {
      const [category] = key.split(":");
      const group = grouped.get(category) ?? {include: [], exclude: []};
      group[state].push(key);
      grouped.set(category, group);
    }
    let count = 0;
    for (const cell of grid.children) {
      const tags = new Set(cell.dataset.tags.split("|").filter(Boolean));
      const tagMatch = [...grouped.values()].every((group) =>
        (!group.include.length || group.include.some((tag) => tags.has(tag)))
        && group.exclude.every((tag) => !tags.has(tag)));
      const textMatch = !this.searchQuery || cell.dataset.search.includes(this.searchQuery);
      cell.hidden = !(tagMatch && textMatch);
      cell.classList.toggle("selected", cell.dataset.id === this.session.selectedId);
      if (!cell.hidden) count += 1;
    }
    const counter = this.parts.search?.querySelector("[data-results-count]");
    if (counter) counter.textContent = String(count);
  }

  #advanceTag(button, direction = "forward") {
    const key = `${button.dataset.category}:${button.dataset.tag}`;
    const oldState = this.filters.get(key) ?? null;
    const next = direction === "forward"
      ? ({null: "include", include: "exclude", exclude: null})[oldState]
      : ({null: "exclude", exclude: "include", include: null})[oldState];
    if (next) this.filters.set(key, next);
    else this.filters.delete(key);
    button.classList.toggle("include", next === "include");
    button.classList.toggle("exclude", next === "exclude");
    this.#updateGrid();
  }

  selectedEntry() {
    return this.database.get(this.session.selectedId) ?? null;
  }

  targetActor() {
    return game.actors.get(this.session.targetActorId) ?? null;
  }

  static async #selectImage(_event, target) {
    this.session.selectedId = target.dataset.id;
    await this.render({parts: ["details"]});
    this.#updateGrid();
  }

  static async #toggleTag(_event, target) {
    this.#advanceTag(target);
  }

  static async #clearFilters() {
    this.filters.clear();
    await this.render({parts: ["tags"]});
    this.#updateGrid();
  }

  static async #assignPortrait() {
    await this.#assign(false);
  }

  static async #assignPortraitToken() {
    await this.#assign(true);
  }

  async #assign(includeToken) {
    const entry = this.selectedEntry();
    if (!entry) return ui.notifications.warn(game.i18n.localize("FIC.NoSelection"));
    try {
      if (await assignArtwork(this.targetActor(), entry, {includeToken})) await this.render({parts: ["details"]});
    } catch (error) {
      ui.notifications.error(error.message);
    }
  }

  static async #createActor() {
    const entry = this.selectedEntry();
    if (!entry) return ui.notifications.warn(game.i18n.localize("FIC.NoSelection"));
    try {
      const actor = await createActorFromArtwork(entry);
      this.session.targetActorId = actor.id;
      await this.render({parts: ["details"]});
    } catch (error) {
      ui.notifications.error(error.message);
    }
  }

  static async #inspectImage() {
    const entry = this.selectedEntry();
    if (!entry) return;
    new foundry.applications.apps.ImagePopout(entry.portrait, {
      title: entry.caption || entry.filename,
      shareable: true
    }).render(true);
  }
}
