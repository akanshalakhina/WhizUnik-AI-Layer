/**
 * WhizUnik database schema (SQLite).
 *
 * Every business table carries `client_id`; every query in the AI layer filters
 * on it. The `ai_*` tables hold only AI usage / audit / history / cache data.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'standard',
  cash_balance REAL NOT NULL DEFAULT 0,
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  ai_permitted_roles TEXT NOT NULL DEFAULT '["management"]',
  ai_monthly_cost_limit_inr REAL NOT NULL DEFAULT 2000,
  ai_monthly_request_limit INTEGER NOT NULL DEFAULT 1500,
  ai_daily_user_limit INTEGER NOT NULL DEFAULT 40
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('management','sales','procurement','warehouse','finance','checker')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  credit_limit REAL NOT NULL DEFAULT 0,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  contact_email TEXT,
  contact_phone TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  lead_time_days INTEGER NOT NULL DEFAULT 14,
  contact_email TEXT,
  bank_account TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  stock_on_hand INTEGER NOT NULL DEFAULT 0,
  reserved_qty INTEGER NOT NULL DEFAULT 0,
  quarantined_qty INTEGER NOT NULL DEFAULT 0,
  damaged_qty INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE (client_id, sku)
);

CREATE TABLE IF NOT EXISTS sales_history (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  sale_date TEXT NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  movement_date TEXT NOT NULL,
  type TEXT NOT NULL,
  qty INTEGER NOT NULL,
  reference TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS cycle_counts (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  count_date TEXT NOT NULL,
  system_qty INTEGER NOT NULL,
  counted_qty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  so_number TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL,
  order_date TEXT NOT NULL,
  promised_date TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  waiting_note TEXT,
  UNIQUE (client_id, so_number)
);

CREATE TABLE IF NOT EXISTS sales_order_lines (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  invoice_number TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sales_order_id INTEGER REFERENCES sales_orders(id),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  UNIQUE (client_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  po_number TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL,
  order_date TEXT NOT NULL,
  expected_date TEXT NOT NULL,
  received_date TEXT,
  total REAL NOT NULL DEFAULT 0,
  UNIQUE (client_id, po_number)
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  received_qty INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_prices (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  price_date TEXT NOT NULL,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_bills (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  bill_number TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_order_id INTEGER REFERENCES purchase_orders(id),
  due_date TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  UNIQUE (client_id, bill_number)
);

CREATE TABLE IF NOT EXISTS warehouse_tasks (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  task_number TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  sales_order_id INTEGER REFERENCES sales_orders(id),
  purchase_order_id INTEGER REFERENCES purchase_orders(id),
  product_id INTEGER REFERENCES products(id),
  due_date TEXT NOT NULL,
  assigned_to TEXT,
  note TEXT,
  UNIQUE (client_id, task_number)
);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  order_ref TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  marketplace_sku TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  qty INTEGER NOT NULL DEFAULT 1,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  order_date TEXT NOT NULL,
  invoice_id INTEGER REFERENCES invoices(id),
  return_reason TEXT,
  UNIQUE (client_id, order_ref)
);

CREATE TABLE IF NOT EXISTS marketplace_settlements (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  settlement_ref TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  expected_date TEXT NOT NULL,
  expected_amount REAL NOT NULL,
  received_amount REAL,
  status TEXT NOT NULL,
  note TEXT,
  UNIQUE (client_id, settlement_ref)
);

CREATE TABLE IF NOT EXISTS marketplace_api_events (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  event_ref TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (client_id, event_ref)
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  approval_ref TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_ref TEXT NOT NULL,
  amount REAL,
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  status TEXT NOT NULL,
  exception_note TEXT,
  UNIQUE (client_id, approval_ref)
);

-- ---------------------------------------------------------------- AI layer
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ask',
  question TEXT NOT NULL,
  created_at TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_inr REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_audit_log (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  client_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  category TEXT,
  tools_used TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  processing_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_inr REAL NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS ai_history (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  question TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL,
  response_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_summary_cache (
  client_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (client_id, role, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_products_client ON products(client_id);
CREATE INDEX IF NOT EXISTS idx_sales_history ON sales_history(client_id, product_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_so_client ON sales_orders(client_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_client ON invoices(client_id, due_date);
CREATE INDEX IF NOT EXISTS idx_po_client ON purchase_orders(client_id, status);
CREATE INDEX IF NOT EXISTS idx_wt_client ON warehouse_tasks(client_id, status);
CREATE INDEX IF NOT EXISTS idx_mo_client ON marketplace_orders(client_id, status);
CREATE INDEX IF NOT EXISTS idx_usage_client ON ai_usage(client_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_usage_user ON ai_usage(user_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_audit_client ON ai_audit_log(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_history_user ON ai_history(user_id, created_at);
`;
