import type {PageUrl} from './admin-api';
import type {Allocation} from './operations';

export type ProtectionAction = 'redirecionar' | 'substituir-cta';

export type EntryPolicy = {version: number; enabled: boolean; approved_destination: string; allocation: Allocation;
  stealth: boolean; stealth_version?: number | null; bound?: boolean};
export type CtaPolicy = {version: number; enabled: boolean; surface: string; pathname: string; allocation: Allocation;
  stealth?: boolean; active?: boolean; bound?: boolean; bound_page?: string | null};
export type Point = {id: string; surface: string; marker: string | null; offer: string | null; kind: string;
  destination_id: string | null; url: string | null; review_required: boolean; suspension: string | null};
export type Destination = {id: string; offer: string; url: string};
export type Protection = {
  project: {id: string; origin: string};
  page: EntryPolicy | null;
  ctaSurfaces: CtaPolicy[];
  destinations: Destination[];
  versions: EntryPolicy[];
  externalDestinations: string[];
};
export type PageProtection = {
  page: {id: string; name: string; enabled: boolean; url_generation: string; config_generation: string; url_review_required: boolean};
  approvalId: string | null;
  urls: PageUrl[];
  entryPolicies: EntryPolicy[];
  ctaPolicies: CtaPolicy[];
  points: Point[];
};
export type Operational = {state: null | {
  revision: number; enabled: boolean; copy_origin: string; copy_pathname: string;
  approval_id: string; url_generation: string; config_generation: string;
}};
export type Incident = {
  incident_id: string; host: string; status: string; triage_version: string | null;
  first_observed_at: string; last_observed_at: string;
  observation_sources: {source: string; day: string}[];
  browser_claims: {traffic_class: string; source: string; observed_at: string}[];
  contextual_assessment: {reason?: string} | null;
  operator_profile: unknown;
  assessments: unknown[];
  linked_evidence: {available: boolean; events: Record<string, unknown>[]; total: number; omitted: number};
  status_audit: {available: boolean; events: {id: string; previous_status: string; new_status: string; justification: string; recorded_at: string}[]};
  timeline: {available: boolean; events: {id: string; event_type: string; source: string; recorded_at: string; summary: unknown}[]};
  infrastructure: {available: boolean; dns: unknown[]};
  notification: unknown;
  degradation: unknown;
  project_cta_context: unknown;
};
