const DB_NAME = 'GymTrackerDB';
const DB_VERSION = 2;

export const DEFAULTS = {
    sets: 3,
    reps: 10,
    restSeconds: 90,
    // Middle of the plan's own "1-2 RIR on compounds, ~1 on isolation" range —
    // a neutral starting point until a template sets something more specific.
    rir: 2,
};

export function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

class Database {
    constructor() {
        this.db = null;
    }

    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Database upgrade blocked — close other tabs running this app.'));
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const tx = event.target.transaction;
                const oldVersion = event.oldVersion;

                if (!db.objectStoreNames.contains('exercises')) {
                    const store = db.createObjectStore('exercises', { keyPath: 'id' });
                    store.createIndex('muscleGroup', 'muscleGroup', { unique: false });
                    store.createIndex('equipment', 'equipment', { unique: false });
                    store.createIndex('isCustom', 'isCustom', { unique: false });
                }

                if (!db.objectStoreNames.contains('templates')) {
                    const store = db.createObjectStore('templates', { keyPath: 'id' });
                    store.createIndex('name', 'name', { unique: false });
                }

                if (!db.objectStoreNames.contains('workouts')) {
                    const store = db.createObjectStore('workouts', { keyPath: 'id' });
                    store.createIndex('date', 'date', { unique: false });
                    store.createIndex('status', 'status', { unique: false });
                } else {
                    const store = tx.objectStore('workouts');
                    if (!store.indexNames.contains('status')) {
                        store.createIndex('status', 'status', { unique: false });
                    }
                }

                // Blobs live apart from exercise records so listing the library
                // never pulls video bytes into memory.
                if (!db.objectStoreNames.contains('media')) {
                    db.createObjectStore('media', { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }

                // v1 stored template.exercises as bare id strings; v2 needs
                // per-exercise sets/reps/rest.
                if (oldVersion >= 1 && oldVersion < 2) {
                    const store = tx.objectStore('templates');
                    store.openCursor().onsuccess = (e) => {
                        const cursor = e.target.result;
                        if (!cursor) return;
                        const template = cursor.value;
                        if (Array.isArray(template.exercises)) {
                            let changed = false;
                            template.exercises = template.exercises.map((entry) => {
                                if (typeof entry !== 'string') return entry;
                                changed = true;
                                return { exerciseId: entry, ...DEFAULTS };
                            });
                            if (changed) cursor.update(template);
                        }
                        cursor.continue();
                    };
                }
            };
        });
    }

    _run(storeNames, mode, work) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeNames, mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
            result = work(tx);
        });
    }

    _get(storeName, key) {
        return new Promise((resolve, reject) => {
            const request = this.db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    _getAll(storeName) {
        return new Promise((resolve, reject) => {
            const request = this.db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    _put(storeName, value) {
        return this._run(storeName, 'readwrite', (tx) => {
            tx.objectStore(storeName).put(value);
            return value;
        });
    }

    _delete(storeName, key) {
        return this._run(storeName, 'readwrite', (tx) => {
            tx.objectStore(storeName).delete(key);
        });
    }

    // --- Exercises -------------------------------------------------------

    getExercises() {
        return this._getAll('exercises');
    }

    getExerciseById(id) {
        return this._get('exercises', id);
    }

    /** Upsert. Caller owns `id` and `isCustom` — nothing is forced here. */
    saveExercise(exercise) {
        const record = {
            createdAt: new Date().toISOString(),
            ...exercise,
            id: exercise.id || uid(),
            isCustom: exercise.isCustom !== false,
        };
        return this._put('exercises', record);
    }

    deleteExercise(id) {
        return this._delete('exercises', id);
    }

    /**
     * Inserts any default exercise that isn't already in the store, in a
     * single transaction. Every field is user-editable (equipment,
     * attachment, name, notes — all of it), so once a row exists this never
     * touches it again: re-running the seed must not stomp an edit the user
     * made to a stock exercise.
     */
    seedExercises(defaults) {
        return this._run('exercises', 'readwrite', (tx) => {
            const store = tx.objectStore('exercises');
            defaults.forEach((exercise) => {
                const request = store.get(exercise.id);
                request.onsuccess = () => {
                    if (request.result) return;
                    store.put({
                        createdAt: new Date().toISOString(),
                        mediaId: null,
                        ...exercise,
                        isCustom: false,
                    });
                };
            });
        });
    }

    /**
     * Removes stock exercises (isCustom: false) that are no longer in the
     * current default set — e.g. after swapping in a different routine's
     * exercise list — and strips them out of any template that referenced
     * them. Exercises the user added themselves (isCustom: true) are never
     * touched. Workout history is untouched too: entries snapshot exercise
     * name/muscle/equipment independently, so it survives the exercise
     * record being deleted.
     */
    async pruneStockExercises(keepIds) {
        const [exercises, templates] = await Promise.all([this._getAll('exercises'), this._getAll('templates')]);
        const toRemove = exercises.filter((e) => e.isCustom === false && !keepIds.has(e.id));
        if (!toRemove.length) return toRemove;

        const removedIds = new Set(toRemove.map((e) => e.id));

        await this._run(['exercises', 'templates', 'media'], 'readwrite', (tx) => {
            const exerciseStore = tx.objectStore('exercises');
            const templateStore = tx.objectStore('templates');
            const mediaStore = tx.objectStore('media');

            toRemove.forEach((exercise) => {
                exerciseStore.delete(exercise.id);
                if (exercise.mediaId) mediaStore.delete(exercise.mediaId);
            });

            templates.forEach((template) => {
                if (!Array.isArray(template.exercises)) return;
                const filtered = template.exercises.filter((entry) => !removedIds.has(entry.exerciseId));
                if (filtered.length !== template.exercises.length) {
                    templateStore.put({ ...template, exercises: filtered });
                }
            });
        });

        return toRemove;
    }

    // --- Media -----------------------------------------------------------

    getMedia(id) {
        return this._get('media', id);
    }

    saveMedia(blob) {
        const record = { id: uid(), blob, type: blob.type };
        return this._put('media', record);
    }

    deleteMedia(id) {
        return this._delete('media', id);
    }

    // --- Templates -------------------------------------------------------

    getTemplates() {
        return this._getAll('templates');
    }

    getTemplateById(id) {
        return this._get('templates', id);
    }

    saveTemplate(template) {
        const record = {
            createdAt: new Date().toISOString(),
            ...template,
            id: template.id || uid(),
        };
        return this._put('templates', record);
    }

    deleteTemplate(id) {
        return this._delete('templates', id);
    }

    /**
     * One-time fixup for the "Example: …" templates — reference copies of the
     * real plan, so counting them double-counted every weekly volume target
     * once `inWeeklyPlan` was introduced.
     *
     * Deliberately runs once and never again (guarded by a setting) and only
     * touches templates that have never had the flag set either way, so
     * turning one back on in the editor afterwards sticks. The name match is
     * a migration heuristic, not app logic: templates created from here on
     * are governed purely by the toggle, whatever they're called.
     */
    async excludeExampleTemplatesOnce() {
        if (await this.getSetting('exampleTemplatesExcluded', false)) return 0;

        const templates = await this._getAll('templates');
        const unflagged = templates.filter(
            (template) => template.inWeeklyPlan === undefined && String(template.name).startsWith('Example:'),
        );

        if (unflagged.length) {
            await this._run('templates', 'readwrite', (tx) => {
                const store = tx.objectStore('templates');
                unflagged.forEach((template) => store.put({ ...template, inWeeklyPlan: false }));
            });
        }

        await this.setSetting('exampleTemplatesExcluded', true);
        return unflagged.length;
    }

    // --- Workouts --------------------------------------------------------

    getWorkouts() {
        return this._getAll('workouts');
    }

    getWorkoutById(id) {
        return this._get('workouts', id);
    }

    saveWorkout(workout) {
        const record = { ...workout, id: workout.id || uid() };
        return this._put('workouts', record);
    }

    deleteWorkout(id) {
        return this._delete('workouts', id);
    }

    async getActiveWorkout() {
        const workouts = await this._getAll('workouts');
        return workouts.find((w) => w.status === 'active') || null;
    }

    // --- Settings --------------------------------------------------------

    async getSetting(key, fallback = null) {
        const row = await this._get('settings', key);
        return row ? row.value : fallback;
    }

    setSetting(key, value) {
        return this._put('settings', { key, value });
    }

    // --- Backup ----------------------------------------------------------

    async exportAll() {
        const [exercises, templates, workouts, settings] = await Promise.all([
            this._getAll('exercises'),
            this._getAll('templates'),
            this._getAll('workouts'),
            this._getAll('settings'),
        ]);
        // Media blobs are deliberately excluded — they can run to hundreds of
        // megabytes and would make the backup file unusable.
        return {
            format: 'gym-tracker-backup',
            version: 2,
            exportedAt: new Date().toISOString(),
            exercises: exercises.map(({ mediaId, ...rest }) => rest),
            templates,
            workouts,
            settings,
        };
    }

    async importAll(data) {
        if (!data || data.format !== 'gym-tracker-backup') {
            throw new Error('Not a Gym Tracker backup file.');
        }
        const stores = ['exercises', 'templates', 'workouts', 'settings'];
        await this._run(stores, 'readwrite', (tx) => {
            stores.forEach((name) => {
                const rows = data[name];
                if (!Array.isArray(rows)) return;
                const store = tx.objectStore(name);
                rows.forEach((row) => store.put(row));
            });
        });
    }
}

export const database = new Database();
