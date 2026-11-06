// Čtení pokut a potvrzení (Claude). Volá aplikace TCS Správa (záložka Pokuty).
//  action "batch":  { batch_id } – projde skeny dávky (fine_files kind=sken bez parsed), rozdělí je na jednotlivé pokuty,
//                   přečte údaje, založí fines (parse_status navrzeno) a soubory kind=pokuta, spáruje SPZ → auto → cesta → posádka.
//  action "proof":  { file_id } – přečte potvrzení (platba / nahlášení řidiče) a porovná s pokutou (částka, reference, lhůta).
// Klíč: ANTHROPIC_API_KEY v Edge Function secrets. Práva: volající musí mít zápis do modulu fines (ověřuje se v DB).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";

const MODEL = "claude-sonnet-5-5";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Doc = {
  pages: [number, number]; is_fine: boolean; country: string | null; authority: string | null; case_no: string | null
  offense_at: string | null; place: string | null; plate: string | null; offense: string | null; amount: number | null; currency: string | null
  due_pay: string | null; due_driver: string | null; payment_iban: string | null; payment_ref: string | null; note: string | null
};

const SPLIT_PROMPT = `Dostáváš sken (PDF) jedné nebo více dopravních pokut / výzev úřadů z Evropy (DE, FR, BE, NL, AT, CH, IT, ES, PL, CZ…), případně i dokumenty, které pokuta nejsou (potvrzení o doručení, poučení, obálka).
Rozděl PDF na jednotlivé dokumenty podle čísla jednacího, SPZ a hlavičky úřadu. Vícestránkový dokument (výzva + poučení + složenka ke stejnému případu) patří dohromady.
Vrať POUZE JSON (bez komentáře) ve tvaru:
{"documents":[{"pages":[od,do],"is_fine":true,"country":"DE","authority":"…","case_no":"…","offense_at":"2026-10-03T14:21:00","place":"…","plate":"7SJ0487","offense":"rychlost +23 km/h (v obci)","amount":60,"currency":"EUR","due_pay":"2026-11-20","due_driver":"2026-11-12","payment_iban":"…","payment_ref":"…","note":"…"}]}
Pravidla: stránky číslovat od 1; offense_at jako ISO datum a čas přestupku (ne datum dopisu); plate bez mezer a pomlček, velkými písmeny; amount číslo bez měny; due_pay = lhůta zaplacení, due_driver = lhůta pro sdělení řidiče (pokud dokument něco z toho nemá, null); offense česky, stručně, včetně výše překročení; note = cokoli důležitého (odvolání, body, výzva k identifikaci řidiče bez pokuty…). Když dokument není pokuta, is_fine=false a ostatní pole null kromě note (co to je).`;

const PROOF_PROMPT = (fine: Record<string, unknown>) => `Dostáváš potvrzení (PDF nebo obrázek) k dopravní pokutě. Údaje pokuty: ${JSON.stringify(fine)}.
Urči, co to je: "platba" (potvrzení banky / příkaz k úhradě / výpis), "nahlaseni" (potvrzení o odeslání sdělení řidiče / formulář identifikace řidiče), nebo "jine".
Vrať POUZE JSON: {"kind":"platba","date":"2026-11-05","amount":60,"currency":"EUR","iban":"…","reference":"…","recipient":"…","matches":{"amount":true,"reference":true,"recipient":true},"ok":true,"note":"stručně, co sedí a co ne"}
U "nahlaseni": date = datum odeslání, amount null, matches podle čísla jednacího a SPZ. "ok" = dokument odpovídá téhle pokutě a je úplný. Porovnávej IBAN a referenci po odstranění mezer.`;

async function claude(apiKey: string, prompt: string, file: { bytes: Uint8Array; mime: string }): Promise<string> {
  let bin = ""; for (let i = 0; i < file.bytes.length; i += 0x8000) bin += String.fromCharCode(...file.bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  const block = file.mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: file.mime, data: b64 } };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude nevrátil JSON: " + text.slice(0, 200));
  return m[0];
}

const normPlate = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Chybí ANTHROPIC_API_KEY v nastavení Supabase (Edge Functions → Secrets)." }, 500);
    const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = req.headers.get("Authorization") ?? "";
    // oprávnění volajícího
    const user = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: can, error: permErr } = await user.rpc("can_write", { mod: "fines" });
    if (permErr || !can) return json({ error: "Nemáte oprávnění zapisovat pokuty." }, 403);
    const db = createClient(url, service);
    const body = await req.json();

    if (body.action === "batch") {
      const { data: batch } = await db.from("fine_batches").select("*").eq("id", body.batch_id).single();
      if (!batch) return json({ error: "Dávka nenalezena." }, 404);
      const { data: scans } = await db.from("fine_files").select("*").eq("batch_id", batch.id).eq("kind", "sken").is("parsed", null);
      const { data: cars } = await db.from("cars").select("id,plate");
      const carBy = new Map((cars ?? []).map((c: { id: string; plate: string | null }) => [normPlate(c.plate), c.id]));
      const out: { created: number; skipped: number; errors: string[] } = { created: 0, skipped: 0, errors: [] };
      for (const scan of scans ?? []) {
        try {
          const dl = await db.storage.from("fines").download(scan.path);
          if (dl.error || !dl.data) throw new Error("Soubor nejde stáhnout: " + dl.error?.message);
          const bytes = new Uint8Array(await dl.data.arrayBuffer());
          const mime = scan.mime === "application/pdf" || scan.file_name?.toLowerCase().endsWith(".pdf") ? "application/pdf" : (scan.mime ?? "image/jpeg");
          const parsed = JSON.parse(await claude(apiKey, SPLIT_PROMPT, { bytes, mime })) as { documents: Doc[] };
          const pdf = mime === "application/pdf" ? await PDFDocument.load(bytes, { ignoreEncryption: true }) : null;
          for (const d of parsed.documents ?? []) {
            // vlastní soubor pro každý dokument (výřez stránek), u obrázku celý soubor
            let path = scan.path, pages: string | null = null;
            if (pdf && d.pages && pdf.getPageCount() > 1) {
              const [a, b] = d.pages; const from = Math.max(1, a), to = Math.min(pdf.getPageCount(), b);
              const part = await PDFDocument.create();
              const copied = await part.copyPages(pdf, Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
              copied.forEach((p) => part.addPage(p));
              const partBytes = await part.save();
              path = scan.path.replace(/\.pdf$/i, "") + `_s${from}-${to}.pdf`; pages = `${from}-${to}`;
              const up = await db.storage.from("fines").upload(path, partBytes, { contentType: "application/pdf", upsert: true });
              if (up.error) throw new Error("Nahrání části: " + up.error.message);
            }
            const carId = carBy.get(normPlate(d.plate)) ?? null;
            let tripId: string | null = null, personId: string | null = null, phase: string | null = null;
            if (carId && d.offense_at) {
              const { data: cands } = await db.rpc("fine_candidates", { p_car: carId, p_at: d.offense_at });
              const hit = (cands ?? []).find((c: { phase: string | null }) => c.phase) ?? ((cands ?? []).length === 1 ? cands![0] : null);
              if (hit) {
                tripId = hit.trip_id; phase = hit.phase ?? "mimo";
                const { data: t } = await db.from("trips").select("guard1_id").eq("id", hit.trip_id).single();
                personId = t?.guard1_id ?? null;
              } else if ((cands ?? []).length === 0) phase = "mimo";
            }
            const { data: fine, error } = await db.from("fines").insert({
              batch_id: batch.id, status: d.is_fine ? (batch.handed_on ? "predano" : "nova") : "neni_pokuta",
              country: d.country, authority: d.authority, case_no: d.case_no, offense_at: d.offense_at, place: d.place, plate: d.plate ? normPlate(d.plate) : null,
              car_id: carId, trip_id: tripId, person_id: personId, phase, liability: phase === "presun" ? "SEMS" : null,
              offense: d.offense, amount: d.amount, currency: d.currency ?? "EUR", due_pay: d.due_pay, due_driver: d.due_driver,
              payment_iban: d.payment_iban, payment_ref: d.payment_ref, parse_status: "navrzeno", parsed: d, note: d.note,
            }).select("id").single();
            if (error) throw new Error("Zápis pokuty: " + error.message);
            await db.from("fine_files").insert({ fine_id: fine.id, batch_id: batch.id, kind: "pokuta", path, file_name: pages ? `${scan.file_name?.replace(/\.pdf$/i, "") ?? "sken"} (str. ${pages}).pdf` : scan.file_name, mime, size: null, pages, parsed: d });
            out.created++;
          }
          await db.from("fine_files").update({ parsed: parsed as unknown as Record<string, unknown>, parse_note: `${parsed.documents?.length ?? 0} dokumentů` }).eq("id", scan.id);
        } catch (e) {
          out.errors.push(`${scan.file_name}: ${(e as Error).message}`);
          await db.from("fine_files").update({ parse_note: "Chyba: " + (e as Error).message }).eq("id", scan.id);
        }
      }
      return json(out);
    }

    if (body.action === "proof") {
      const { data: file } = await db.from("fine_files").select("*").eq("id", body.file_id).single();
      if (!file?.fine_id) return json({ error: "Soubor nenalezen." }, 404);
      const { data: fine } = await db.from("fines").select("*").eq("id", file.fine_id).single();
      const dl = await db.storage.from("fines").download(file.path);
      if (dl.error || !dl.data) return json({ error: "Soubor nejde stáhnout." }, 500);
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      const mime = file.mime === "application/pdf" || file.file_name?.toLowerCase().endsWith(".pdf") ? "application/pdf" : (file.mime ?? "image/jpeg");
      const info = { case_no: fine.case_no, plate: fine.plate, amount: fine.amount, currency: fine.currency, payment_iban: fine.payment_iban, payment_ref: fine.payment_ref, due_pay: fine.due_pay, due_driver: fine.due_driver, authority: fine.authority };
      const r = JSON.parse(await claude(apiKey, PROOF_PROMPT(info), { bytes, mime })) as { kind: string; date: string | null; amount: number | null; ok: boolean; note: string; matches: Record<string, boolean> };
      const late = (due: string | null) => !!(due && r.date && r.date > due);
      const patch: Record<string, unknown> = {};
      let note = r.note ?? "";
      if (r.kind === "platba") {
        patch.paid_on = r.date; patch.paid_amount = r.amount; patch.paid_ok = !!r.ok && !late(fine.due_pay);
        if (late(fine.due_pay)) note += ` Zaplaceno po lhůtě (${fine.due_pay}).`;
        if (fine.status === "nova" || fine.status === "predano") patch.status = "zaplaceno";
      } else if (r.kind === "nahlaseni") {
        patch.driver_reported_on = r.date; patch.reported_ok = !!r.ok && !late(fine.due_driver);
        if (late(fine.due_driver)) note += ` Odesláno po lhůtě (${fine.due_driver}).`;
        if (fine.status === "nova" || fine.status === "predano") patch.status = "ridic_nahlasen";
      }
      await db.from("fines").update(patch).eq("id", fine.id);
      await db.from("fine_files").update({ kind: r.kind === "platba" ? "platba" : r.kind === "nahlaseni" ? "nahlaseni" : "jine", parsed: r, parse_note: (r.ok && !late(r.kind === "platba" ? fine.due_pay : fine.due_driver) ? "✓ sedí. " : "✗ nesedí. ") + note }).eq("id", file.id);
      return json({ ok: true, result: r, note });
    }
    return json({ error: "Neznámá akce." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
