CREATE TYPE form_status AS ENUM (
  'received',
  'validated',
  'geocoded',
  'completed',
  'validation_failed',
  'geocode_failed',
  'transform_failed'
);

CREATE TABLE forms (
  id BIGSERIAL PRIMARY KEY,
  application_reference TEXT NOT NULL UNIQUE,
  raw_payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  status form_status NOT NULL DEFAULT 'received',
  transformed_payload JSONB,
  last_error JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbox_emails (
  id BIGSERIAL PRIMARY KEY,
  form_id BIGINT NOT NULL REFERENCES forms (id),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX outbox_emails_unsent_idx ON outbox_emails (next_retry_at) WHERE sent_at IS NULL;

CREATE TABLE form_events (
  id BIGSERIAL PRIMARY KEY,
  form_id BIGINT NOT NULL REFERENCES forms (id),
  from_status form_status,
  to_status form_status,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- form_events is an append-only audit trail.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: append-only table', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER form_events_append_only
  BEFORE UPDATE OR DELETE ON form_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
