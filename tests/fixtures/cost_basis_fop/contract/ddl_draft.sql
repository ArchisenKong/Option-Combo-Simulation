-- Standalone FOP ledger: schema draft (P1 contract).
-- CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §8.1, §8.2 item 7 and §13.3 P1.
--
-- This is the frozen structure, not the migration. P2 writes the migration in
-- cost_basis_store.py, assigns the next free schema version and must keep
-- these tables, columns and constraints; changing them means revising this
-- file and its tests first. Revised in P2, before any release: section 9
-- (the request log) answers the P2 review (R5, R7, R11).
--
-- Run order (tests/cost_basis_fop_contract_test.py follows it):
--   PRAGMA foreign_keys = OFF   (before BEGIN; it has no effect inside one)
--   BEGIN IMMEDIATE
--   every statement below, in order
--   PRAGMA foreign_key_check    (must return no rows, otherwise ROLLBACK)
--   COMMIT
--   PRAGMA foreign_keys = ON    (always, also after a failure)
--
-- Every statement ends with ';' at the end of a line and contains no other ';'.
--
-- Time text has one fixed-width form (protocol.json "formats"): a date is
-- YYYY-MM-DD and an economic or evidence instant YYYY-MM-DDTHH:MM:SS.ffffffZ,
-- UTC with exactly six fractional digits, keeping every digit the source gave.
-- The GLOB checks below refuse any other spelling ('.' is literal in GLOB), so
-- comparing two of these columns as text, as the range check does, is
-- comparing them as times. created_at_utc/updated_at_utc stay in the store's
-- existing whole-second write stamp and are never compared with them.
-- Revisioned tables keep old rows: a new revision is a new row, and the old
-- row's superseded_by_revision names it. Cross-table references that point
-- at a (id, revision) pair are checked by cost_basis_fop_domain.py, because
-- SQLite cannot express them as foreign keys.

-- 1. cost_basis_books: default_shares_per_contract becomes nullable, a stock
--    ledger must still carry it. Parent-table rebuild in SQLite's documented
--    order: new table, copy, drop old, rename new (plan §8.2 item 7).
CREATE TABLE cost_basis_books_new (
    book_id                     TEXT PRIMARY KEY,
    account                     TEXT NOT NULL,
    symbol                      TEXT NOT NULL,
    sec_type                    TEXT NOT NULL DEFAULT 'STK',
    currency                    TEXT NOT NULL DEFAULT 'USD',
    default_shares_per_contract INTEGER
                                CHECK (default_shares_per_contract IS NULL
                                       OR default_shares_per_contract > 0),
    start_date                  TEXT NOT NULL,
    note                        TEXT NOT NULL DEFAULT '',
    created_at_utc              TEXT NOT NULL,
    updated_at_utc              TEXT NOT NULL,
    archived_at_utc             TEXT,
    CHECK (sec_type <> 'STK' OR default_shares_per_contract IS NOT NULL)
);
INSERT INTO cost_basis_books_new (
    book_id, account, symbol, sec_type, currency, default_shares_per_contract,
    start_date, note, created_at_utc, updated_at_utc, archived_at_utc)
    SELECT book_id, account, symbol, sec_type, currency, default_shares_per_contract,
           start_date, note, created_at_utc, updated_at_utc, archived_at_utc
    FROM cost_basis_books;
DROP TABLE cost_basis_books;
ALTER TABLE cost_basis_books_new RENAME TO cost_basis_books;
CREATE UNIQUE INDEX idx_cost_basis_books_account_symbol
    ON cost_basis_books(account COLLATE NOCASE, symbol, sec_type, currency)
    WHERE archived_at_utc IS NULL;

-- 2. One row per FOP ledger. A FUT ledger without this row is a legacy ledger:
--    export and delete only (plan §8.2 item 3). product_rules is checked
--    against the supported-product list in code, not here, so adding a
--    product needs no table rebuild.
CREATE TABLE cost_basis_fop_books (
    book_id          TEXT PRIMARY KEY REFERENCES cost_basis_books(book_id),
    engine_version   INTEGER NOT NULL CHECK (engine_version >= 1),
    product_rules    TEXT NOT NULL,
    history_scope    TEXT NOT NULL CHECK (history_scope IN ('full_history', 'since_baseline')),
    created_at_utc   TEXT NOT NULL,
    updated_at_utc   TEXT NOT NULL
);

-- 3. Contract terms: the only place a FOP ledger keeps identity (plan §8.1).
--    First release: physically delivered FOP with a positive strike (§1.2).
CREATE TABLE cost_basis_fop_contracts (
    contract_id                    TEXT NOT NULL,
    revision                       INTEGER NOT NULL CHECK (revision >= 1),
    book_id                        TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    sec_type                       TEXT NOT NULL CHECK (sec_type IN ('FUT', 'FOP')),
    con_id                         INTEGER CHECK (con_id IS NULL OR con_id > 0),
    root                           TEXT NOT NULL,
    trading_class                  TEXT,
    local_symbol                   TEXT,
    exchange                       TEXT NOT NULL,
    currency                       TEXT NOT NULL,
    future_contract_month          TEXT CHECK (future_contract_month IS NULL
                                               OR (length(future_contract_month) = 6
                                                   AND future_contract_month GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]')),
    future_last_trade_date         TEXT CHECK (future_last_trade_date IS NULL
                                               OR future_last_trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    future_last_trade_as_of        TEXT CHECK (future_last_trade_as_of IS NULL
                                               OR future_last_trade_as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]Z'),
    future_point_value             REAL CHECK (future_point_value IS NULL OR future_point_value > 0),
    option_right                   TEXT CHECK (option_right IS NULL OR option_right IN ('C', 'P')),
    option_strike                  REAL CHECK (option_strike IS NULL OR option_strike > 0),
    option_expiry                  TEXT CHECK (option_expiry IS NULL OR option_expiry GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    option_expiry_as_of            TEXT CHECK (option_expiry_as_of IS NULL
                                               OR option_expiry_as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]Z'),
    premium_multiplier             REAL CHECK (premium_multiplier IS NULL OR premium_multiplier > 0),
    deliverable_futures_per_option REAL CHECK (deliverable_futures_per_option IS NULL
                                               OR deliverable_futures_per_option > 0),
    settlement_type                TEXT CHECK (settlement_type IS NULL OR settlement_type IN ('physical_future')),
    exercise_style                 TEXT CHECK (exercise_style IS NULL OR exercise_style IN ('american', 'european')),
    rule_version                   TEXT NOT NULL,
    evidence_status                TEXT NOT NULL CHECK (evidence_status IN (
                                       'verified_broker', 'verified_statement', 'manual_attested',
                                       'unresolved', 'conflict')),
    evidence_summary               TEXT NOT NULL DEFAULT '',
    observed_at_utc                TEXT NOT NULL CHECK (observed_at_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]Z'),
    superseded_by_revision         INTEGER CHECK (superseded_by_revision IS NULL
                                                  OR superseded_by_revision > revision),
    created_at_utc                 TEXT NOT NULL,
    PRIMARY KEY (contract_id, revision),
    CHECK (
        (sec_type = 'FUT'
         AND future_contract_month IS NOT NULL AND future_point_value IS NOT NULL
         AND option_right IS NULL AND option_strike IS NULL AND option_expiry IS NULL
         AND option_expiry_as_of IS NULL AND premium_multiplier IS NULL
         AND deliverable_futures_per_option IS NULL AND settlement_type IS NULL
         AND exercise_style IS NULL)
        OR
        (sec_type = 'FOP'
         AND option_right IS NOT NULL AND option_strike IS NOT NULL AND option_expiry IS NOT NULL
         AND premium_multiplier IS NOT NULL AND deliverable_futures_per_option IS NOT NULL
         AND settlement_type IS NOT NULL AND exercise_style IS NOT NULL
         AND future_contract_month IS NULL AND future_last_trade_date IS NULL
         AND future_last_trade_as_of IS NULL AND future_point_value IS NULL)
    )
);
CREATE UNIQUE INDEX idx_cost_basis_fop_contracts_current_con_id
    ON cost_basis_fop_contracts(book_id, con_id)
    WHERE con_id IS NOT NULL AND superseded_by_revision IS NULL;
CREATE INDEX idx_cost_basis_fop_contracts_book
    ON cost_basis_fop_contracts(book_id, contract_id);

-- 4. FOP -> FUT binding with its evidence (plan §4.3). A verified status
--    needs the server's candidate digest; unresolved and conflict carry no FUT.
CREATE TABLE cost_basis_fop_bindings (
    binding_id             TEXT NOT NULL,
    revision               INTEGER NOT NULL CHECK (revision >= 1),
    book_id                TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    option_contract_id     TEXT NOT NULL,
    future_contract_id     TEXT,
    status                 TEXT NOT NULL CHECK (status IN (
                               'verified_broker', 'verified_statement', 'manual_attested',
                               'unresolved', 'conflict')),
    evidence_summary       TEXT NOT NULL DEFAULT '',
    evidence_digest        TEXT,
    observed_at_utc        TEXT NOT NULL CHECK (observed_at_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]Z'),
    superseded_by_revision INTEGER CHECK (superseded_by_revision IS NULL
                                          OR superseded_by_revision > revision),
    created_at_utc         TEXT NOT NULL,
    PRIMARY KEY (binding_id, revision),
    CHECK ((status IN ('unresolved', 'conflict')) = (future_contract_id IS NULL)),
    CHECK (status NOT IN ('verified_broker', 'verified_statement') OR evidence_digest IS NOT NULL)
);
CREATE UNIQUE INDEX idx_cost_basis_fop_bindings_current
    ON cost_basis_fop_bindings(book_id, option_contract_id)
    WHERE superseded_by_revision IS NULL;

-- 5. Per-event FOP facts (plan §8.1): contract references and their frozen
--    revisions, typed categories, and the time facts behind the economic
--    order (§9.2). No second copy of quantity, cash or contract terms, and no
--    cycle membership.
CREATE TABLE cost_basis_fop_event_details (
    event_id                    TEXT PRIMARY KEY REFERENCES cost_basis_events(event_id),
    book_id                     TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    contract_id                 TEXT,
    contract_revision           INTEGER,
    delivered_contract_id       TEXT,
    delivered_contract_revision INTEGER,
    binding_id                  TEXT,
    binding_revision            INTEGER,
    open_close                  TEXT CHECK (open_close IS NULL OR open_close IN ('O', 'C', 'CO')),
    fee_category                TEXT CHECK (fee_category IS NULL OR fee_category IN (
                                    'futures', 'short_option', 'long_option', 'strategy')),
    fee_is_refund               INTEGER NOT NULL DEFAULT 0 CHECK (fee_is_refund IN (0, 1)),
    fee_source_event_id         TEXT REFERENCES cost_basis_events(event_id),
    adjustment_scope            TEXT CHECK (adjustment_scope IS NULL
                                            OR adjustment_scope IN ('strategy', 'seller_lens')),
    baseline_kind               TEXT CHECK (baseline_kind IS NULL OR baseline_kind IN (
                                    'trade_cost', 'reference_price', 'unknown_cost')),
    baseline_as_of_utc          TEXT CHECK (baseline_as_of_utc IS NULL
                                            OR baseline_as_of_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]Z'),
    exchange_trade_date         TEXT CHECK (exchange_trade_date IS NULL
                                            OR exchange_trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    executed_at_utc             TEXT CHECK (executed_at_utc IS NULL
                                            OR executed_at_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]Z'),
    time_range_start_utc        TEXT CHECK (time_range_start_utc IS NULL
                                            OR time_range_start_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]Z'),
    time_range_end_utc          TEXT CHECK (time_range_end_utc IS NULL
                                            OR time_range_end_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]Z'),
    source_time_text            TEXT,
    source_timezone             TEXT,
    order_evidence              TEXT,
    CHECK ((contract_id IS NULL) = (contract_revision IS NULL)),
    CHECK ((delivered_contract_id IS NULL) = (delivered_contract_revision IS NULL)),
    CHECK ((binding_id IS NULL) = (binding_revision IS NULL)),
    CHECK ((executed_at_utc IS NULL) = (time_range_start_utc IS NOT NULL)),
    CHECK ((time_range_start_utc IS NULL) = (time_range_end_utc IS NULL)),
    CHECK (time_range_start_utc IS NULL OR time_range_start_utc <= time_range_end_utc)
);
CREATE INDEX idx_cost_basis_fop_event_details_book
    ON cost_basis_fop_event_details(book_id, contract_id);

-- 6. Cycle boundaries only; which cycle an event belongs to is derived
--    (plan §1.3, §13.2). A closed boundary is anchored on the event that
--    brought every FUT/FOP balance to zero.
CREATE TABLE cost_basis_fop_cycles (
    boundary_id            TEXT NOT NULL,
    revision               INTEGER NOT NULL CHECK (revision >= 1),
    book_id                TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    state                  TEXT NOT NULL CHECK (state IN ('closed', 'revoked')),
    anchor_event_id        TEXT REFERENCES cost_basis_events(event_id),
    label                  TEXT NOT NULL DEFAULT '',
    superseded_by_revision INTEGER CHECK (superseded_by_revision IS NULL
                                          OR superseded_by_revision > revision),
    created_at_utc         TEXT NOT NULL,
    PRIMARY KEY (boundary_id, revision),
    CHECK ((state = 'closed') = (anchor_event_id IS NOT NULL))
);

-- 7. Normalized source records and their allocation to events (plan §8.1).
--    raw_fields_json keeps the statement's own field names and values as
--    evidence; it never replaces an economic column. Allocations survive a
--    void: a consumed broker reference stays consumed.
CREATE TABLE cost_basis_fop_sources (
    source_id       TEXT PRIMARY KEY,
    book_id         TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    account         TEXT NOT NULL,
    namespace       TEXT NOT NULL CHECK (namespace IN (
                        'flex_trade', 'ib_exec', 'activity_row', 'tws_exec')),
    source_ref      TEXT NOT NULL,
    capability_key  TEXT,
    format          TEXT,
    section         TEXT,
    raw_fields_json TEXT NOT NULL,
    stated_quantity REAL,
    stated_fees     REAL,
    import_batch_id TEXT,
    created_at_utc  TEXT NOT NULL,
    UNIQUE (book_id, account, namespace, source_ref)
);
CREATE TABLE cost_basis_fop_source_allocations (
    source_id      TEXT NOT NULL REFERENCES cost_basis_fop_sources(source_id),
    event_id       TEXT NOT NULL REFERENCES cost_basis_events(event_id),
    role           TEXT NOT NULL CHECK (role IN ('trade', 'option_leg', 'future_leg', 'fee')),
    quantity       REAL,
    fees           REAL CHECK (fees IS NULL OR fees >= 0),
    created_at_utc TEXT NOT NULL,
    PRIMARY KEY (source_id, event_id, role)
);
CREATE INDEX idx_cost_basis_fop_source_allocations_event
    ON cost_basis_fop_source_allocations(event_id);

-- 8. Metadata operations, the reference revisions they made, and the event
--    id mapping a rebuild produced (plan §4.3, §8.3). payload_digest makes a
--    retried token with a different payload detectable.
CREATE TABLE cost_basis_fop_operations (
    operation_id         TEXT PRIMARY KEY,
    book_id              TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    client_token         TEXT NOT NULL UNIQUE,
    kind                 TEXT NOT NULL CHECK (kind IN (
                             'adopt_binding', 'correct_contract', 'close_cycle',
                             'revoke_cycle', 'rebuild')),
    payload_digest       TEXT NOT NULL,
    ledger_digest_before TEXT NOT NULL,
    ledger_digest_after  TEXT NOT NULL,
    created_at_utc       TEXT NOT NULL
);
CREATE TABLE cost_basis_fop_reference_revisions (
    operation_id    TEXT NOT NULL REFERENCES cost_basis_fop_operations(operation_id),
    event_id        TEXT NOT NULL REFERENCES cost_basis_events(event_id),
    reference       TEXT NOT NULL CHECK (reference IN (
                        'contract', 'delivered_contract', 'binding', 'fee_source')),
    before_id       TEXT,
    before_revision INTEGER,
    after_id        TEXT,
    after_revision  INTEGER,
    PRIMARY KEY (operation_id, event_id, reference)
);
CREATE TABLE cost_basis_fop_event_id_mappings (
    operation_id TEXT NOT NULL REFERENCES cost_basis_fop_operations(operation_id),
    old_event_id TEXT NOT NULL,
    new_event_id TEXT NOT NULL REFERENCES cost_basis_events(event_id),
    PRIMARY KEY (operation_id, old_event_id)
);

-- 9. One row per accepted FOP write request: its token, what it asked and what
--    it was answered. A retry with the same token is the same request only
--    when the action and the request digest match, and then it gets the stored
--    answer whatever the ledger has become since; any other use of the token
--    is refused. A reset, restore or rebuild replaces the graph but keeps
--    these rows; deleting the ledger removes them. A backup carries them, and
--    a restore under the same ledger id brings them back (never under another
--    id, where every token is new). Not part of the ledger version.
CREATE TABLE cost_basis_fop_requests (
    client_token   TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL REFERENCES cost_basis_books(book_id),
    action         TEXT NOT NULL CHECK (action IN (
                       'append', 'void', 'metadata', 'reset', 'restore_reset',
                       'restore_backup', 'rebuild', 'import')),
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    result_json    TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);
