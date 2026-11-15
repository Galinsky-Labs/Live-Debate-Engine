-- E33/E37: anonymous, read-only public catalog. Only published event administration, the exact
-- published motion revision, announced results summaries and published transcripts (without
-- principal identifiers) are exposed. No credential is used and nothing is writable.
CREATE FUNCTION lde_competition.public_catalog(t uuid,e uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE events jsonb;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Tenant required'; END IF;
 WITH ev AS (
   SELECT DISTINCT ON (r.entity_id) r.entity_id, r.canonical_record::jsonb->'data' AS d, r.revision
   FROM lde.revisions r WHERE r.tenant_id=t AND r.kind='event' AND (e IS NULL OR r.entity_id=e)
   ORDER BY r.entity_id, r.revision DESC
 ), published AS (
   SELECT * FROM ev WHERE d->>'state'='published' AND d ? 'broadcastMode'
 ), rows AS (
   SELECT p.entity_id, jsonb_build_object(
     'eventId',p.entity_id,'title',p.d->>'title','venue',p.d->>'venue','broadcastMode',p.d->>'broadcastMode','revision',p.revision,
     'motion',(SELECT jsonb_build_object('motionId',m.entity_id,'revision',m.revision,'wording',m.canonical_record::jsonb#>>'{data,wording}',
        'description',m.canonical_record::jsonb#>>'{data,description}','categories',m.canonical_record::jsonb#>'{data,categories}')
        FROM lde.revisions m WHERE m.tenant_id=t AND m.kind='motion' AND m.entity_id=(p.d->>'motionId')::uuid AND m.revision=(p.d->>'motionRevision')::integer),
     'phase',(SELECT o.canonical_record::jsonb#>>'{data,state,phase}' FROM lde.revisions o WHERE o.tenant_id=t AND o.event_id=p.entity_id AND o.kind='operation'
        AND o.canonical_record::jsonb#>>'{data,stream}'='live' ORDER BY o.recorded_at DESC, o.revision DESC LIMIT 1),
     'results',(SELECT jsonb_build_object('version',s->'version','resultsHash',s->'resultsHash','announcedAt',s->'announcedAt',
        'audience',CASE WHEN s->'audience'='null'::jsonb THEN NULL ELSE jsonb_build_object('decision',s#>'{audience,verdict,decision}','cohort',s#>'{audience,verdict,cohort}',
          'preCounts',s#>'{audience,verdict,preCounts}','postCounts',s#>'{audience,verdict,postCounts}','explanation',s#>'{audience,verdict,explanation}') END,
        'judges',CASE WHEN s->'judges'='null'::jsonb THEN NULL ELSE jsonb_build_object('decision',s#>'{judges,verdict,decision}','seats',s#>'{judges,verdict,seats}',
          'forScore',s#>'{judges,verdict,forScore}','againstScore',s#>'{judges,verdict,againstScore}') END,
        'advancement',s->'advancement')
        FROM (SELECT o.canonical_record::jsonb#>'{data,state}' AS s FROM lde.revisions o WHERE o.tenant_id=t AND o.event_id=p.entity_id AND o.kind='operation'
          AND o.canonical_record::jsonb#>>'{data,stream}'='results' ORDER BY o.recorded_at DESC, o.revision DESC LIMIT 1) x WHERE s->>'status'='announced'),
     'transcript',CASE WHEN e IS NULL THEN NULL ELSE (SELECT jsonb_agg(jsonb_build_object('offsetMs',seg->'offsetMs','durationMs',seg->'durationMs','text',seg->'text','revision',seg->'revision') ORDER BY (seg->>'offsetMs')::bigint)
        FROM (SELECT o.canonical_record::jsonb#>'{data,state}' AS s FROM lde.revisions o WHERE o.tenant_id=t AND o.event_id=p.entity_id AND o.kind='operation'
          AND o.canonical_record::jsonb#>>'{data,stream}'='transcript' ORDER BY o.recorded_at DESC, o.revision DESC LIMIT 1) x, jsonb_array_elements(x.s->'segments') seg
        WHERE x.s->>'status'='published') END
   ) AS item FROM published p
 )
 SELECT COALESCE(jsonb_agg(item ORDER BY item->>'title', entity_id),'[]'::jsonb) INTO events FROM (SELECT * FROM rows LIMIT 200) z;
 RETURN jsonb_build_object('apiVersion','public-v1','tenantId',t,'events',events);
END;
$body$;
ALTER FUNCTION lde_competition.public_catalog(uuid,uuid) OWNER TO lde_guard;
REVOKE ALL ON FUNCTION lde_competition.public_catalog(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lde_competition.public_catalog(uuid,uuid) TO lde_runtime;
