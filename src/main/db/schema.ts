/**
 * 建库 DDL：库文件不存在时由 connection.open() 执行，建全部业务表 + FTS 表并写入
 * settings.schema_version。
 *
 * 这里是建库 DDL 的**唯一真源**，随功能直接维护：改 `SCHEMA_SQL` 后要同步升
 * `SCHEMA_VERSION`，并在 migrate.ts 的迁移链里补上同号步骤，旧库才会跟着补齐。
 * 当前 SCHEMA_VERSION = 18，共 28 张表。
 * v15 加了密码保险箱的 vault_meta / vault_entry；
 * v16 给 note 加了知识库需要的 kind / verified_at / archived_at / verify_note；
 * v17 给 flash 加了 content_format（网页剪藏保留原格式时存 HTML）。
 * v18 把 task_note_ref 的数据并入 task_note_link（见 migrate.ts 的说明）。
 */
export const SCHEMA_VERSION = 18

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS attachment (
	id INTEGER NOT NULL, 
	note_id INTEGER NOT NULL, 
	path VARCHAR NOT NULL, 
	kind VARCHAR, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(note_id) REFERENCES note (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS flash (
	id INTEGER NOT NULL, 
	content TEXT NOT NULL, 
	content_format VARCHAR DEFAULT 'text', 
	remark VARCHAR, 
	source_app VARCHAR, 
	source_url VARCHAR, 
	status VARCHAR, 
	converted_type VARCHAR, 
	converted_id INTEGER, 
	deleted_at DATETIME, 
	created_at DATETIME, 
	PRIMARY KEY (id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS flash_fts USING fts5(content, remark, flash_id UNINDEXED, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS flash_tag (
	flash_id INTEGER NOT NULL, 
	tag_id INTEGER NOT NULL, 
	PRIMARY KEY (flash_id, tag_id), 
	FOREIGN KEY(flash_id) REFERENCES flash (id) ON DELETE CASCADE, 
	FOREIGN KEY(tag_id) REFERENCES tag (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS list_folder (
	id INTEGER NOT NULL, 
	parent_id INTEGER, 
	kind VARCHAR, 
	name VARCHAR NOT NULL, 
	icon VARCHAR, 
	collapsed BOOLEAN, 
	sort FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(parent_id) REFERENCES list_folder (id)
);
CREATE TABLE IF NOT EXISTS note (
	id INTEGER NOT NULL, 
	folder_id INTEGER, 
	title VARCHAR NOT NULL, 
	content_md TEXT, 
	format VARCHAR NOT NULL, 
	pinned BOOLEAN, 
	word_count INTEGER, 
	deleted_at DATETIME, 
	created_at DATETIME, 
	updated_at DATETIME, 
	kind TEXT NOT NULL DEFAULT 'note', 
	verified_at DATETIME, 
	archived_at DATETIME, 
	verify_note TEXT, 
	PRIMARY KEY (id), 
	FOREIGN KEY(folder_id) REFERENCES note_folder (id)
);
CREATE TABLE IF NOT EXISTS note_folder (
	id INTEGER NOT NULL, 
	parent_id INTEGER, 
	name VARCHAR NOT NULL, 
	sort FLOAT, 
	PRIMARY KEY (id), 
	FOREIGN KEY(parent_id) REFERENCES note_folder (id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(title, content, note_id UNINDEXED, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS note_link (
	id INTEGER NOT NULL, 
	src_note_id INTEGER NOT NULL, 
	dst_note_id INTEGER, 
	dst_title VARCHAR NOT NULL, 
	link_kind TEXT NOT NULL DEFAULT 'related', 
	PRIMARY KEY (id), 
	CONSTRAINT uq_src_dst_title UNIQUE (src_note_id, dst_title), 
	FOREIGN KEY(src_note_id) REFERENCES note (id) ON DELETE CASCADE, 
	FOREIGN KEY(dst_note_id) REFERENCES note (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS note_revision (
	id INTEGER NOT NULL, 
	note_id INTEGER NOT NULL, 
	title VARCHAR, 
	content_md TEXT, 
	format VARCHAR, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(note_id) REFERENCES note (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS note_tag (
	note_id INTEGER NOT NULL, 
	tag_id INTEGER NOT NULL, 
	PRIMARY KEY (note_id, tag_id), 
	FOREIGN KEY(note_id) REFERENCES note (id) ON DELETE CASCADE, 
	FOREIGN KEY(tag_id) REFERENCES tag (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pomodoro_session (
	id INTEGER NOT NULL, 
	task_id INTEGER, 
	started_at DATETIME, 
	minutes INTEGER, 
	completed BOOLEAN, 
	reason VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(task_id) REFERENCES task (id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS settings (
	"key" VARCHAR NOT NULL, 
	value TEXT, 
	PRIMARY KEY ("key")
);
CREATE TABLE IF NOT EXISTS tag (
	id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	color VARCHAR, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);
CREATE TABLE IF NOT EXISTS task (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	title VARCHAR NOT NULL, 
	notes_md TEXT, 
	status VARCHAR, 
	priority INTEGER, 
	due_date DATE, 
	start_date DATE, 
	reminder_at DATETIME, 
	resume_at DATE, 
	list_id INTEGER, 
	parent_id INTEGER, 
	repeat_period VARCHAR, 
	repeat_rule VARCHAR, 
	streak INTEGER, 
	last_reset_date DATE, 
	sort_key FLOAT, 
	completed_at DATETIME, 
	deleted_at DATETIME, 
	created_at DATETIME, 
	updated_at DATETIME, 
	FOREIGN KEY(list_id) REFERENCES list_folder (id), 
	FOREIGN KEY(parent_id) REFERENCES task (id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(title, notes, task_id UNINDEXED, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS task_note_context (
	id INTEGER NOT NULL, 
	task_id INTEGER NOT NULL, 
	note_id INTEGER NOT NULL, 
	block_key VARCHAR NOT NULL, 
	snippet TEXT, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_task_note_block UNIQUE (task_id, note_id, block_key), 
	FOREIGN KEY(task_id) REFERENCES task (id) ON DELETE CASCADE, 
	FOREIGN KEY(note_id) REFERENCES note (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_note_link (
	id INTEGER NOT NULL, 
	task_id INTEGER NOT NULL, 
	note_id INTEGER NOT NULL, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_task_note UNIQUE (task_id, note_id), 
	FOREIGN KEY(task_id) REFERENCES task (id) ON DELETE CASCADE, 
	FOREIGN KEY(note_id) REFERENCES note (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_note_ref (
	id INTEGER NOT NULL, 
	task_id INTEGER NOT NULL, 
	note_id INTEGER NOT NULL, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_task_note_ref UNIQUE (task_id, note_id), 
	FOREIGN KEY(task_id) REFERENCES task (id) ON DELETE CASCADE, 
	FOREIGN KEY(note_id) REFERENCES note (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_tag (
	task_id INTEGER NOT NULL, 
	tag_id INTEGER NOT NULL, 
	PRIMARY KEY (task_id, tag_id), 
	FOREIGN KEY(task_id) REFERENCES task (id) ON DELETE CASCADE, 
	FOREIGN KEY(tag_id) REFERENCES tag (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workflow_instance (
	id INTEGER NOT NULL, 
	template_id INTEGER NOT NULL, 
	title VARCHAR, 
	status VARCHAR, 
	current_node_id INTEGER, 
	origin_task_id INTEGER, 
	created_at DATETIME, 
	finished_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(template_id) REFERENCES workflow_template (id) ON DELETE CASCADE, 
	FOREIGN KEY(current_node_id) REFERENCES workflow_node (id) ON DELETE SET NULL, 
	FOREIGN KEY(origin_task_id) REFERENCES task (id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS workflow_node (
	id INTEGER NOT NULL, 
	template_id INTEGER NOT NULL, 
	title VARCHAR NOT NULL, 
	detail TEXT, 
	order_index INTEGER, 
	note_id INTEGER, 
	action_kind VARCHAR, 
	action_value TEXT, 
	condition VARCHAR, 
	branch_node_id INTEGER, 
	pos_x FLOAT, 
	pos_y FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(template_id) REFERENCES workflow_template (id) ON DELETE CASCADE, 
	FOREIGN KEY(note_id) REFERENCES note (id) ON DELETE SET NULL, 
	FOREIGN KEY(branch_node_id) REFERENCES workflow_node (id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS workflow_step_task (
	id INTEGER NOT NULL, 
	instance_id INTEGER NOT NULL, 
	node_id INTEGER NOT NULL, 
	task_id INTEGER NOT NULL, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_wf_step_node UNIQUE (instance_id, node_id), 
	FOREIGN KEY(instance_id) REFERENCES workflow_instance (id) ON DELETE CASCADE, 
	FOREIGN KEY(node_id) REFERENCES workflow_node (id) ON DELETE CASCADE, 
	FOREIGN KEY(task_id) REFERENCES task (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workflow_template (
	id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	description TEXT, 
	start_policy VARCHAR, 
	created_at DATETIME, 
	updated_at DATETIME, 
	PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS task_activity (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	task_id INTEGER NOT NULL, 
	kind VARCHAR NOT NULL, 
	detail TEXT, 
	reason TEXT, 
	created_at DATETIME, 
	FOREIGN KEY(task_id) REFERENCES task (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workflow_run_log (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	instance_id INTEGER NOT NULL, 
	node_id INTEGER, 
	kind VARCHAR NOT NULL, 
	detail TEXT, 
	created_at DATETIME, 
	FOREIGN KEY(instance_id) REFERENCES workflow_instance (id) ON DELETE CASCADE, 
	FOREIGN KEY(node_id) REFERENCES workflow_node (id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS vault_meta (
	id INTEGER PRIMARY KEY CHECK (id = 1), 
	kdf_salt BLOB NOT NULL, 
	kdf_params TEXT NOT NULL, 
	verifier_ct BLOB NOT NULL, 
	verifier_iv BLOB NOT NULL, 
	created_at DATETIME
);
CREATE TABLE IF NOT EXISTS vault_entry (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	title_ct BLOB NOT NULL, 
	title_iv BLOB NOT NULL, 
	username_ct BLOB, 
	username_iv BLOB, 
	password_ct BLOB NOT NULL, 
	password_iv BLOB NOT NULL, 
	url_ct BLOB, 
	url_iv BLOB, 
	notes_ct BLOB, 
	notes_iv BLOB, 
	tags_ct BLOB, 
	tags_iv BLOB, 
	created_at DATETIME, 
	updated_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_vault_entry_updated ON vault_entry (updated_at DESC);
`
