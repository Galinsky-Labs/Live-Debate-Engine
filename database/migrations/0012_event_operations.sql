-- E09-E12+: event operation streams on the shared immutable snapshot ledger.
-- Domain reducers run in trusted application code; the database authorizes every write
-- against a fixed (stream, action) allow-list, enforces optimistic revisions, replay and audit.
ALTER TABLE lde.subjects DROP CONSTRAINT subjects_kind_check;
ALTER TABLE lde.subjects ADD CONSTRAINT subjects_kind_check CHECK (kind IN ('tenant','series','motion','participant','team','ruleset','tournament','event','assignment','contract','session','poll','ballot','scorecard','audience-verdict','judges-verdict','advancement-decision','prize-obligation','tournament-match','dispute','operation'));

INSERT INTO lde_security.access_rules VALUES
('participant.self','event',ARRAY['producer','moderator','timekeeper','debater','judge','audience','finance','oversight'],ARRAY[]::text[],true,false),
('floor.participate','event',ARRAY['debater'],ARRAY[]::text[],true,false);

CREATE TABLE lde_competition.operation_streams (
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z-]{1,39}$'),
  action text NOT NULL REFERENCES lde_security.access_rules(action),
  purpose text NOT NULL CHECK (purpose IN ('write','read')),
  PRIMARY KEY (stream, action, purpose)
);
INSERT INTO lde_competition.operation_streams VALUES
('roster','event.manage','write'),('roster','event.read','read'),
('eligibility','event.manage','write'),('eligibility','participant.self','write'),('eligibility','event.manage','read'),
('schedule','event.manage','write'),('schedule','event.read','read'),
('admission','event.manage','write'),('admission','participant.self','write'),('admission','event.manage','read');
ALTER TABLE lde_competition.operation_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE lde_competition.operation_streams FORCE ROW LEVEL SECURITY;
CREATE POLICY guard_streams ON lde_competition.operation_streams TO lde_guard USING (true);
GRANT SELECT ON lde_competition.operation_streams TO lde_guard;

CREATE FUNCTION lde_competition.operation_allowed(s text,a text,p text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $body$
  SELECT EXISTS(SELECT 1 FROM lde_competition.operation_streams WHERE stream=s AND action=a AND purpose=p);
$body$;

-- The replay intent binds the caller's command digest, not the reducer output (which may
-- depend on server time), so an exact retry returns the original result.
CREATE FUNCTION lde_competition.save_operation(t uuid,e uuid,s text,a text,entity uuid,expected integer,d jsonb,h text,c uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE p uuid; intent jsonb:=jsonb_build_object('op','save-operation','event',e,'stream',s,'action',a,'entity',entity,'expected',expected,'command',h);
 result jsonb; prior lde.revisions; r lde.revisions;
BEGIN
 IF s IS NULL OR a IS NULL OR NOT lde_competition.operation_allowed(s,a,'write')
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Operation access denied'; END IF;
 p:=lde_competition.authorize(a,t,e); result:=lde_competition.replay(t,c,intent);
 p:=lde_competition.authorize(a,t,e); IF result IS NOT NULL THEN RETURN result; END IF;
 IF h IS NULL OR h !~ '^[a-f0-9]{64}$' OR jsonb_typeof(d)<>'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation state'; END IF;
 IF NOT EXISTS(SELECT 1 FROM lde.subjects WHERE tenant_id=t AND entity_id=e AND kind='event')
 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Event unavailable'; END IF;
 SELECT * INTO prior FROM lde.revisions WHERE tenant_id=t AND entity_id=entity ORDER BY revision DESC LIMIT 1 FOR UPDATE;
 IF prior.snapshot_id IS NOT NULL AND (prior.kind<>'operation' OR prior.event_id IS DISTINCT FROM e
   OR prior.canonical_record::jsonb#>>'{data,stream}'<>s)
 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Operation stream conflict'; END IF;
 r:=lde_competition.append_record(t,e,entity,'operation',expected,jsonb_build_object('stream',s,'action',a,'state',d,
   'updatedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedBy',p));
 result:=jsonb_build_object('current',lde_competition.admin_envelope(r),'replayed',false);
 RETURN lde_competition.finish(t,c,intent,result,'operation-'||s,entity,r.snapshot_id);
END;
$body$;

CREATE FUNCTION lde_competition.operation_records(t uuid,e uuid,s text,a text,entity uuid,before_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE records jsonb; more boolean; next_revision integer;
BEGIN
 IF s IS NULL OR a IS NULL OR NOT lde_competition.operation_allowed(s,a,'read')
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Operation access denied'; END IF;
 PERFORM lde_competition.authorize(a,t,e);
 IF before_revision IS NULL OR before_revision<1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
 IF entity IS NULL THEN
   WITH latest AS (
     SELECT DISTINCT ON (r.entity_id) r.* FROM lde.revisions r
     WHERE r.tenant_id=t AND r.event_id=e AND r.kind='operation' AND r.canonical_record::jsonb#>>'{data,stream}'=s
     ORDER BY r.entity_id, r.revision DESC
   ), visible AS (SELECT * FROM latest ORDER BY recorded_at DESC, entity_id LIMIT 100)
   SELECT COALESCE((SELECT jsonb_agg(lde_competition.admin_envelope(v::lde.revisions) ORDER BY v.recorded_at DESC, v.entity_id) FROM visible v),'[]'::jsonb)
   INTO records;
   RETURN jsonb_build_object('records',records,'nextRevision',NULL);
 END IF;
 WITH page AS (
   SELECT r.* FROM lde.revisions r WHERE r.tenant_id=t AND r.event_id=e AND r.kind='operation' AND r.entity_id=entity
     AND r.canonical_record::jsonb#>>'{data,stream}'=s AND r.revision<before_revision
   ORDER BY r.revision DESC LIMIT 51
 ), visible AS (SELECT * FROM page ORDER BY revision DESC LIMIT 50)
 SELECT COALESCE((SELECT jsonb_agg(lde_competition.admin_envelope(v::lde.revisions) ORDER BY v.revision DESC) FROM visible v),'[]'::jsonb),
   (SELECT count(*)>50 FROM page),(SELECT min(v.revision) FROM visible v)
 INTO records,more,next_revision;
 RETURN jsonb_build_object('records',records,'nextRevision',CASE WHEN more THEN next_revision ELSE NULL END);
END;
$body$;

-- Server-side current state for an authorized writer. Responses to callers without the
-- stream read action are filtered by the application's per-stream self view.
CREATE FUNCTION lde_competition.operation_state(t uuid,e uuid,s text,a text,entity uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r lde.revisions;
BEGIN
 IF s IS NULL OR a IS NULL OR NOT lde_competition.operation_allowed(s,a,'write')
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Operation access denied'; END IF;
 PERFORM lde_competition.authorize(a,t,e);
 SELECT * INTO r FROM lde.revisions WHERE tenant_id=t AND event_id=e AND entity_id=entity AND kind='operation'
   AND canonical_record::jsonb#>>'{data,stream}'=s ORDER BY revision DESC LIMIT 1;
 IF r.snapshot_id IS NULL THEN RETURN jsonb_build_object('current',NULL); END IF;
 RETURN jsonb_build_object('current',lde_competition.admin_envelope(r));
END;
$body$;

DO $body$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='lde_competition' AND p.proname IN ('operation_allowed','save_operation','operation_records','operation_state')
 LOOP
   EXECUTE format('ALTER FUNCTION %s OWNER TO lde_guard',f.signature);
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END;
$body$;
GRANT EXECUTE ON FUNCTION lde_competition.save_operation(uuid,uuid,text,text,uuid,integer,jsonb,text,uuid),
 lde_competition.operation_records(uuid,uuid,text,text,uuid,integer),
 lde_competition.operation_state(uuid,uuid,text,text,uuid) TO lde_runtime;
