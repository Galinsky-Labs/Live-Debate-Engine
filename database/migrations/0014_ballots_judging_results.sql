-- E20-E26: secret ballots with blind-signed credentials, poll orchestration and paper fallback.
INSERT INTO lde_competition.operation_streams VALUES
('poll','event.manage','write'),('poll','session.control','write'),('poll','event.read','read'),
('paper','result.verify','write'),('paper','result.verify','read'),
('panel','event.manage','write'),('panel','event.read','read'),
('scorecard','scorecard.write-own','write'),('scorecard','result.verify','read'),
('results','result.verify','write'),('results','result.publish','write'),('results','result.verify','read');

-- Who received a credential (never which credential). One per voter per poll.
CREATE TABLE lde_competition.ballot_issuance (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, poll_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES lde_security.principals(id),
  PRIMARY KEY (tenant_id, poll_id, principal_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES lde.subjects(tenant_id, entity_id)
);
-- Anonymous ballots keyed by credential pseudonym. No voter identity and no cast timestamp are stored.
CREATE TABLE lde_competition.ballots (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, poll_id uuid NOT NULL,
  round text NOT NULL CHECK (round IN ('pre','post')),
  pseudonym text NOT NULL CHECK (pseudonym ~ '^[a-f0-9]{64}$'),
  choice text NOT NULL CHECK (choice IN ('for','against','undecided')),
  receipt text NOT NULL CHECK (receipt ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, poll_id, round, pseudonym)
);
DO $body$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['ballot_issuance','ballots'] LOOP
   EXECUTE format('ALTER TABLE lde_competition.%I ENABLE ROW LEVEL SECURITY',n);
   EXECUTE format('ALTER TABLE lde_competition.%I FORCE ROW LEVEL SECURITY',n);
   EXECUTE format('CREATE POLICY guard_internal ON lde_competition.%I TO lde_guard USING (true) WITH CHECK (true)',n);
   EXECUTE format('GRANT SELECT,INSERT ON lde_competition.%I TO lde_guard',n);
 END LOOP;
END;
$body$;
CREATE TRIGGER immutable_ballots BEFORE UPDATE OR DELETE ON lde_competition.ballots FOR EACH ROW EXECUTE FUNCTION lde.reject_history_change();
CREATE TRIGGER immutable_issuance BEFORE UPDATE OR DELETE ON lde_competition.ballot_issuance FOR EACH ROW EXECUTE FUNCTION lde.reject_history_change();

CREATE FUNCTION lde_competition.poll_current(t uuid,e uuid,poll uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $body$
  SELECT r.canonical_record::jsonb#>'{data,state}' FROM lde.revisions r
  WHERE r.tenant_id=t AND r.event_id=e AND r.entity_id=poll AND r.kind='operation' AND r.canonical_record::jsonb#>>'{data,stream}'='poll'
  ORDER BY r.revision DESC LIMIT 1;
$body$;

CREATE FUNCTION lde_competition.ballot_issue(t uuid,e uuid,poll uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE p uuid; s jsonb;
BEGIN
 p:=lde_competition.authorize('ballot.cast-own',t,e);
 PERFORM pg_advisory_xact_lock(hashtextextended('lde:ballot:'||poll::text,0));
 s:=lde_competition.poll_current(t,e,poll);
 IF s IS NULL OR s->>'status' NOT IN ('locked','pre-open') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Credential issuance closed'; END IF;
 IF NOT (s#>'{electorate,digests}') ? encode(sha256(convert_to('lde-electorate-v1|'||p::text,'UTF8')),'hex')
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Not in locked electorate'; END IF;
 INSERT INTO lde_competition.ballot_issuance(tenant_id,event_id,poll_id,principal_id) VALUES(t,e,poll,p);
 RETURN jsonb_build_object('publicKey',s->'publicKey','sealedKey',s->>'sealedKey');
END;
$body$;

CREATE FUNCTION lde_competition.ballot_public_key(t uuid,e uuid,poll uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE s jsonb;
BEGIN
 s:=lde_competition.poll_current(t,e,poll);
 IF s IS NULL OR s->'publicKey' IS NULL OR s->'publicKey'='null'::jsonb THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('publicKey',s->'publicKey','status',s->>'status');
END;
$body$;

-- Anonymous: the application verifies the blind signature before calling. The database bounds
-- ballots per round by credentials issued and accepts only the currently open round.
CREATE FUNCTION lde_competition.ballot_cast(t uuid,e uuid,poll uuid,rnd text,pseudo text,ch text,receipt text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE s jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('lde:ballot:'||poll::text,0));
 s:=lde_competition.poll_current(t,e,poll);
 IF s IS NULL OR s->>'status'<>rnd||'-open' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Round not open'; END IF;
 IF (SELECT count(*) FROM lde_competition.ballots WHERE tenant_id=t AND poll_id=poll AND round=rnd)
    >= (SELECT count(*) FROM lde_competition.ballot_issuance WHERE tenant_id=t AND poll_id=poll)
 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Ballot count exceeds credentials'; END IF;
 INSERT INTO lde_competition.ballots(tenant_id,event_id,poll_id,round,pseudonym,choice,receipt) VALUES(t,e,poll,rnd,pseudo,ch,receipt);
 RETURN receipt;
END;
$body$;

CREATE FUNCTION lde_competition.ballot_tally(t uuid,e uuid,poll uuid,public_board boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE s jsonb; matrix jsonb; unpaired jsonb; receipts jsonb; issued integer;
BEGIN
 IF public_board THEN PERFORM lde_competition.authorize('event.read',t,e); ELSE PERFORM lde_competition.authorize('result.verify',t,e); END IF;
 s:=lde_competition.poll_current(t,e,poll);
 IF s IS NULL OR s->>'status'<>'closed' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Poll not closed'; END IF;
 SELECT COALESCE(jsonb_agg(b.receipt ORDER BY b.receipt),'[]'::jsonb) INTO receipts FROM lde_competition.ballots b WHERE b.tenant_id=t AND b.poll_id=poll;
 IF public_board THEN RETURN jsonb_build_object('receipts',receipts); END IF;
 SELECT count(*) INTO issued FROM lde_competition.ballot_issuance WHERE tenant_id=t AND poll_id=poll;
 SELECT COALESCE(jsonb_object_agg(x.pre||':'||x.post,x.n),'{}'::jsonb) INTO matrix FROM (
   SELECT a.choice AS pre,b.choice AS post,count(*) AS n FROM lde_competition.ballots a JOIN lde_competition.ballots b
   ON b.tenant_id=a.tenant_id AND b.poll_id=a.poll_id AND b.pseudonym=a.pseudonym AND b.round='post'
   WHERE a.tenant_id=t AND a.poll_id=poll AND a.round='pre' GROUP BY a.choice,b.choice) x;
 SELECT COALESCE(jsonb_object_agg(x.round||':'||x.choice,x.n),'{}'::jsonb) INTO unpaired FROM (
   SELECT a.round,a.choice,count(*) AS n FROM lde_competition.ballots a WHERE a.tenant_id=t AND a.poll_id=poll
   AND NOT EXISTS(SELECT 1 FROM lde_competition.ballots b WHERE b.tenant_id=a.tenant_id AND b.poll_id=a.poll_id AND b.pseudonym=a.pseudonym AND b.round<>a.round)
   GROUP BY a.round,a.choice) x;
 RETURN jsonb_build_object('paired',matrix,'unpaired',unpaired,'issued',issued,'electorate',s#>'{electorate,count}','electorateDigest',s#>'{electorate,digest}','receipts',receipts);
END;
$body$;

DO $body$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='lde_competition' AND p.proname IN ('poll_current','ballot_issue','ballot_public_key','ballot_cast','ballot_tally')
 LOOP
   EXECUTE format('ALTER FUNCTION %s OWNER TO lde_guard',f.signature);
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END;
$body$;
GRANT EXECUTE ON FUNCTION lde_competition.ballot_issue(uuid,uuid,uuid), lde_competition.ballot_public_key(uuid,uuid,uuid),
 lde_competition.ballot_cast(uuid,uuid,uuid,text,text,text,text), lde_competition.ballot_tally(uuid,uuid,uuid,boolean) TO lde_runtime;
