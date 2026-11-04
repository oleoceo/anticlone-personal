CREATE TABLE notification_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
 provider text CHECK (provider IN ('brevo','smtp')),
 host text, port integer, tls_mode text CHECK (tls_mode IN ('implicit','starttls')),
 sender text, recipient text, requested boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_settings(singleton) VALUES (true);
CREATE TABLE notification_settings_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 version integer NOT NULL UNIQUE, action text NOT NULL CHECK (action IN ('save','enable','disable')),
 changed_fields text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
