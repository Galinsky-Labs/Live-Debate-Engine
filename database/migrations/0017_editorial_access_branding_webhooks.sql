-- E34-E37: editorial and access streams, tenant white-label configuration, outbound webhooks.
INSERT INTO lde_competition.operation_streams VALUES
('editorial','event.manage','write'),('editorial','event.manage','read'),
('access','event.manage','write'),('access','participant.self','write'),('access','prize.manage','write'),('access','event.manage','read');

CREATE TABLE lde_competition.tenant_branding (
  tenant_id uuid PRIMARY KEY REFERENCES lde.tenants(id), config jsonb NOT NULL CHECK (jsonb_typeof(config)='object' AND octet_length(config::text)<=16384),
  revision integer NOT NULL CHECK (revision>0), updated_by uuid NOT NULL REFERENCES lde_security.principals(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE lde_competition.webhook_subscriptions (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES lde.tenants(id),
  url text NOT NULL CHECK (url ~ '^https://[a-z0-9.-]+(:[0-9]{2,5})?(/[A-Za-z0-9._~!$&''()*+,;=:@/%-]*)?$' AND length(url)<=500),
  kinds text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 20), sealed_secret text NOT NULL, active boolean NOT NULL,
  created_by uuid NOT NULL REFERENCES lde_security.principals(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE lde_competition.webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, subscription_id uuid NOT NULL REFERENCES lde_competition.webhook_subscriptions(id),
  tenant_id uuid NOT NULL, snapshot_id uuid NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')), attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_status integer, UNIQUE (subscription_id, snapshot_id)
);
CREATE INDEX webhook_due ON lde_competition.webhook_deliveries(next_attempt_at) WHERE status='pending';
DO $body$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['tenant_branding','webhook_subscriptions','webhook_deliveries'] LOOP
   EXECUTE format('ALTER TABLE lde_competition.%I ENABLE ROW LEVEL SECURITY',n);
   EXECUTE format('ALTER TABLE lde_competition.%I FORCE ROW LEVEL SECURITY',n);
   EXECUTE format('CREATE POLICY guard_internal ON lde_competition.%I TO lde_guard USING (true) WITH CHECK (true)',n);
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON lde_competition.%I TO lde_guard',n);
 END LOOP;
END;
$body$;

CREATE FUNCTION lde_competition.save_branding(t uuid,expected integer,d jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE p uuid; current_revision integer;
BEGIN
 p:=lde_competition.authorize('tenant.manage',t,NULL);
 IF jsonb_typeof(d)<>'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid branding'; END IF;
 SELECT revision INTO current_revision FROM lde_competition.tenant_branding WHERE tenant_id=t FOR UPDATE;
 IF coalesce(current_revision,0)<>expected THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Branding revision conflict'; END IF;
 INSERT INTO lde_competition.tenant_branding(tenant_id,config,revision,updated_by) VALUES(t,d,expected+1,p)
 ON CONFLICT (tenant_id) DO UPDATE SET config=excluded.config,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=clock_timestamp();
 RETURN jsonb_build_object('revision',expected+1,'config',d);
END;
$body$;
CREATE FUNCTION lde_competition.public_branding(t uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
  SELECT jsonb_build_object('apiVersion','public-v1','tenantId',t,'revision',b.revision,'brand',b.config) FROM lde_competition.tenant_branding b WHERE b.tenant_id=t;
$body$;

CREATE FUNCTION lde_competition.save_webhook(t uuid,w uuid,u text,k text[],sealed text,is_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE p uuid;
BEGIN
 p:=lde_competition.authorize('tenant.manage',t,NULL);
 IF EXISTS(SELECT 1 FROM lde_competition.webhook_subscriptions WHERE id=w AND tenant_id<>t) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Webhook unavailable'; END IF;
 IF sealed='' AND NOT EXISTS(SELECT 1 FROM lde_competition.webhook_subscriptions WHERE id=w) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='New webhook requires a secret'; END IF;
 IF (SELECT count(*) FROM lde_competition.webhook_subscriptions WHERE tenant_id=t AND id<>w)>=10 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='Webhook limit'; END IF;
 INSERT INTO lde_competition.webhook_subscriptions(id,tenant_id,url,kinds,sealed_secret,active,created_by) VALUES(w,t,u,k,sealed,is_active,p)
 ON CONFLICT (id) DO UPDATE SET url=excluded.url,kinds=excluded.kinds,sealed_secret=CASE WHEN excluded.sealed_secret='' THEN webhook_subscriptions.sealed_secret ELSE excluded.sealed_secret END,active=excluded.active,updated_at=clock_timestamp();
 RETURN jsonb_build_object('id',w,'url',u,'kinds',to_jsonb(k),'active',is_active);
END;
$body$;
CREATE FUNCTION lde_competition.list_webhooks(t uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 PERFORM lde_competition.authorize('tenant.manage',t,NULL);
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'url',s.url,'kinds',to_jsonb(s.kinds),'active',s.active,
   'pending',(SELECT count(*) FROM lde_competition.webhook_deliveries d WHERE d.subscription_id=s.id AND d.status='pending'),
   'failed',(SELECT count(*) FROM lde_competition.webhook_deliveries d WHERE d.subscription_id=s.id AND d.status='failed')) ORDER BY s.id)
   FROM lde_competition.webhook_subscriptions s WHERE s.tenant_id=t),'[]'::jsonb);
END;
$body$;
-- Metadata-only notifications: receivers fetch content through authorized APIs.
CREATE FUNCTION lde_competition.enqueue_webhooks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r lde.revisions; label text;
BEGIN
 SELECT * INTO r FROM lde.revisions WHERE tenant_id=NEW.tenant_id AND snapshot_id=NEW.snapshot_id;
 label:=CASE WHEN r.kind='operation' THEN 'operation:'||(r.canonical_record::jsonb#>>'{data,stream}') ELSE r.kind END;
 INSERT INTO lde_competition.webhook_deliveries(subscription_id,tenant_id,snapshot_id,payload)
 SELECT s.id,NEW.tenant_id,NEW.snapshot_id,jsonb_build_object('type','snapshot.appended','tenantId',NEW.tenant_id,'eventId',r.event_id,'entityId',r.entity_id,
   'kind',label,'revision',r.revision,'snapshotId',NEW.snapshot_id,'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
 FROM lde_competition.webhook_subscriptions s WHERE s.tenant_id=NEW.tenant_id AND s.active AND (label=ANY(s.kinds) OR '*'=ANY(s.kinds))
 ON CONFLICT DO NOTHING;
 RETURN NULL;
END;
$body$;
CREATE TRIGGER enqueue_webhooks AFTER INSERT ON lde.domain_events FOR EACH ROW EXECUTE FUNCTION lde_competition.enqueue_webhooks();
CREATE FUNCTION lde_competition.webhook_claim(n integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE result jsonb;
BEGIN
 WITH due AS (SELECT d.id FROM lde_competition.webhook_deliveries d WHERE d.status='pending' AND d.next_attempt_at<=clock_timestamp()
   ORDER BY d.next_attempt_at LIMIT least(greatest(n,1),20) FOR UPDATE SKIP LOCKED),
 claimed AS (UPDATE lde_competition.webhook_deliveries d SET attempts=d.attempts+1,
   next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,d.attempts)::integer)) FROM due WHERE d.id=due.id RETURNING d.*)
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'attempt',c.attempts,'url',s.url,'sealedSecret',s.sealed_secret,'subscriptionId',s.id,'payload',c.payload)),'[]'::jsonb)
 INTO result FROM claimed c JOIN lde_competition.webhook_subscriptions s ON s.id=c.subscription_id;
 RETURN result;
END;
$body$;
CREATE FUNCTION lde_competition.webhook_ack(delivery bigint,ok boolean,http_status integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 UPDATE lde_competition.webhook_deliveries SET last_status=http_status,
   status=CASE WHEN ok THEN 'delivered' WHEN attempts>=8 THEN 'failed' ELSE 'pending' END WHERE id=delivery AND status='pending';
END;
$body$;
-- E34: published, past-embargo editorial items for the public API.
CREATE FUNCTION lde_competition.public_editorial(t uuid,e uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('articleId',a->'articleId','kind',a->'kind','headline',a->'headline','body',a->'body','channels',a->'channels','publishAt',a->'publishAt','revision',a->'revision') ORDER BY a->>'publishAt' DESC),'[]'::jsonb)
  FROM (SELECT o.canonical_record::jsonb#>'{data,state}' AS s FROM lde.revisions o WHERE o.tenant_id=t AND o.event_id=e AND o.kind='operation'
    AND o.canonical_record::jsonb#>>'{data,stream}'='editorial' AND EXISTS(SELECT 1 FROM lde.revisions ev WHERE ev.tenant_id=t AND ev.entity_id=e AND ev.kind='event'
      AND ev.canonical_record::jsonb#>>'{data,state}'='published' AND ev.revision=(SELECT max(x.revision) FROM lde.revisions x WHERE x.tenant_id=t AND x.entity_id=e))
    ORDER BY o.recorded_at DESC, o.revision DESC LIMIT 1) x, jsonb_array_elements(x.s->'articles') a
  WHERE a->>'status'='published' AND (a->>'publishAt')::timestamptz<=clock_timestamp();
$body$;
DO $body$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='lde_competition' AND p.proname IN ('public_editorial','save_branding','public_branding','save_webhook','list_webhooks','enqueue_webhooks','webhook_claim','webhook_ack')
 LOOP
   EXECUTE format('ALTER FUNCTION %s OWNER TO lde_guard',f.signature);
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END;
$body$;
GRANT EXECUTE ON FUNCTION lde_competition.public_editorial(uuid,uuid), lde_competition.save_branding(uuid,integer,jsonb), lde_competition.public_branding(uuid),
 lde_competition.save_webhook(uuid,uuid,text,text[],text,boolean), lde_competition.list_webhooks(uuid),
 lde_competition.webhook_claim(integer), lde_competition.webhook_ack(bigint,boolean,integer) TO lde_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA lde_competition TO lde_guard;
