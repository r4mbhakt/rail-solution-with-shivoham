import type { IncomingMessage, ServerResponse } from 'node:http';

type ChatMessage = { role: 'user' | 'assistant'; text: string };
type ChatContext = {
  activeRequisitions?: unknown[];
  defectsData?: unknown[];
  trainMasterSummary?: unknown;
};
type RequisitionSummary = {
  id: string;
  department: string;
  section: string;
  status: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  priority: string;
  mlRisk: string | number;
};

const sendJson = (response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.end(JSON.stringify(payload));
};

const readBody = (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) reject(new Error('Request body is too large.'));
  });
  request.on('end', () => resolve(body));
  request.on('error', reject);
});

const getRequisitions = (context: ChatContext): RequisitionSummary[] =>
  (Array.isArray(context.activeRequisitions) ? context.activeRequisitions : []).map((item) => {
    const request = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      id: String(request.id || ''),
      department: String(request.department || ''),
      section: String(request.section || ''),
      status: String(request.status || ''),
      date: String(request.date || ''),
      startTime: String(request.startTime || ''),
      endTime: String(request.endTime || ''),
      durationMinutes: Number(request.durationMinutes || 0),
      priority: String(request.priority || ''),
      mlRisk: typeof request.mlRisk === 'number' || typeof request.mlRisk === 'string' ? request.mlRisk : 'not scored',
    };
  });

const compactRecords = (records: unknown[], fields: string[], limit: number): string[] => records
  .slice(0, limit)
  .map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return JSON.stringify(Object.fromEntries(fields
      .filter((field) => record[field] !== undefined && record[field] !== null && record[field] !== '')
      .map((field) => [field, record[field]])));
  });

const buildContextSummary = (context: ChatContext, message: string): string => {
  const requisitions = getRequisitions(context);
  const defects = Array.isArray(context.defectsData) ? context.defectsData : [];
  const timetable = context.trainMasterSummary && typeof context.trainMasterSummary === 'object'
    ? context.trainMasterSummary as { trains?: unknown[]; sectionTimetable?: unknown[] }
    : {};
  const trains = Array.isArray(timetable.trains) ? timetable.trains : [];
  const movements = Array.isArray(timetable.sectionTimetable) ? timetable.sectionTimetable : [];
  const query = message.toLowerCase();
  const matchingSections = new Set(requisitions
    .filter((request) => `${request.id} ${request.section}`.toLowerCase().split(/[^a-z0-9-]+/).some((token) => token.length > 2 && query.includes(token)))
    .map((request) => request.section.toLowerCase()));
  const relevantMovements = movements.filter((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const searchable = `${record.section || ''} ${record.trainNumber || ''} ${record.trainName || ''}`.toLowerCase();
    return matchingSections.size > 0
      ? Array.from(matchingSections).some((section) => searchable.includes(section)) || searchable.split(/[^a-z0-9-]+/).some((token) => token.length > 2 && query.includes(token))
      : searchable.split(/[^a-z0-9-]+/).some((token) => token.length > 2 && query.includes(token));
  });
  const relevantTrains = trains.filter((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const searchable = `${record.trainNumber || ''} ${record.trainName || ''}`.toLowerCase();
    return searchable.split(/[^a-z0-9-]+/).some((token) => token.length > 2 && query.includes(token));
  });
  return [
    `Active requisitions (${requisitions.length}):`,
    ...compactRecords(requisitions, ['id', 'department', 'section', 'status', 'date', 'startTime', 'endTime', 'durationMinutes', 'stationFrom', 'stationTo', 'lineType', 'workCategory', 'speedRestrictionKmH', 'priority', 'urgencyLevel', 'passengerDelayMins', 'freightDelayMins', 'mlRisk'], 60),
    `Defect/risk records loaded (${defects.length}):`,
    ...compactRecords(defects, ['defectId', 'section', 'department', 'defectType', 'workCategory', 'workDescription', 'speedRestrictionKmH', 'priority', 'urgencyLevel', 'status'], 60),
    `Train master records available: ${trains.length}; matching records for this question:`,
    ...compactRecords(relevantTrains.length > 0 ? relevantTrains : trains, ['trainNumber', 'trainName', 'type', 'source', 'destination', 'priorityClass', 'daysOfRun', 'punctualityPct', 'averagePassengers'], 40),
    `Timetable movements available: ${movements.length}; matching movements for this question:`,
    ...compactRecords(relevantMovements.length > 0 ? relevantMovements : movements, ['trainNumber', 'section', 'arrivalTime', 'departureTime', 'direction', 'days'], 80),
  ].join('\n').slice(0, 30000);
};

const localCopilotReply = (message: string, context: ChatContext): string => {
  const requisitions = getRequisitions(context);
  const lower = message.toLowerCase();
  const matchingRequest = requisitions.find((request) => {
    const tokens = `${request.id} ${request.section}`.toLowerCase().split(/[^a-z0-9-]+/).filter((token) => token.length > 2);
    return tokens.some((token) => lower.includes(token));
  });

  if (matchingRequest) {
    return `Section status: ${matchingRequest.section} (${matchingRequest.id}) is ${matchingRequest.status}. ${matchingRequest.department} has a ${matchingRequest.durationMinutes}-minute window from ${matchingRequest.startTime} to ${matchingRequest.endTime} on ${matchingRequest.date}. Priority: ${matchingRequest.priority}; ML risk: ${matchingRequest.mlRisk}. Check the conflict alert and affected-train panel before authorizing any movement.`;
  }
  if (/\b(hi|hello|hey|namaste|good morning|good evening)\b/.test(lower)) {
    return `Good day, Section Controller. I have ${requisitions.length} active requisition${requisitions.length === 1 ? '' : 's'} on the live board. Ask me about a section, train risk, conflict, or whether P-Way, S&T, and TRD work can be bundled.`;
  }
  if (lower.includes('bundle') || lower.includes('tradeoff') || lower.includes('trade-off')) {
    return 'Bundling recommendation: combine P-Way, S&T, and TRD work only when the section, date, and protection window overlap. The benefit is one coordinated possession; the trade-off is a wider safety envelope, shared isolation planning, and coordinated release checks. Keep independent sections separate.';
  }
  if (lower.includes('train') || lower.includes('risk') || lower.includes('delay') || lower.includes('timetable')) {
    const timetable = context.trainMasterSummary && typeof context.trainMasterSummary === 'object'
      ? context.trainMasterSummary as { trains?: unknown[] }
      : {};
    const trainCount = Array.isArray(timetable.trains) ? timetable.trains.length : 0;
    return `Train-risk summary: ${requisitions.length} active requisitions and ${trainCount} train master records are loaded. Open the delay badge for a requisition to see timetable movements, calculated regulation minutes, mitigation, and section capacity margin.`;
  }
  return `Live board summary: ${requisitions.length} active requisitions are loaded. I can explain section status, train risk, timetable impact, conflict handling, or P-Way/S&T/TRD bundling. No block authority is granted by this assistant.`;
};

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = JSON.parse(await readBody(request)) as { message?: string; history?: ChatMessage[]; context?: ChatContext };
    const message = body.message?.trim() || '';
    const context = body.context || {};
    if (!message || message.length > 2000) {
      sendJson(response, 400, { error: 'Message must be 1-2000 characters' });
      return;
    }

    const apiKey = (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (!apiKey) {
      console.error('[Gemini API Error]: GEMINI_API_KEY is not configured');
      sendJson(response, 200, {
        reply: localCopilotReply(message, context),
        degraded: true,
        degradedReason: 'GEMINI_API_KEY is not configured in the server environment.',
      });
      return;
    }

    const history = (body.history || []).slice(-10).map((item) => ({
      role: item.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: String(item.text || '').slice(0, 4000) }],
    }));
    const systemInstruction = `You are the Gemini Co-Pilot for TRIKAAL-RAKSHA-BLOCK, an Indian Railways Section Controller Assistant.

CURRENT LIVE BOARD CONTEXT:
  ${buildContextSummary(context, message)}

  Rules for accurate answers:
  - Treat the live board context as the source of truth for this conversation.
  - Answer the exact question first, then give the relevant evidence and safety checks.
  - Never invent a train, time, risk score, defect, capacity value, or approval status. If the context does not contain it, say that it is unavailable and state what must be checked.
  - Distinguish facts from recommendations. Recommendations must account for section, date, time window, line type, train movement, and department protection requirements.
  - You may explain a decision, but never grant authority to occupy a line, clear a train, or approve a block. Final authorization remains with the Section Controller and railway rules.
  - Keep answers concise and use short headings or bullets when they improve clarity.`;
    const configuredModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const models = [configuredModel, 'gemini-2.0-flash', 'gemini-2.5-flash']
      .filter((model, index, all) => all.indexOf(model) === index);
    let lastFailure = 'Gemini did not return a response.';

    for (const model of models) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      try {
        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [...history, { role: 'user', parts: [{ text: message }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
            }),
          },
        );
        if (!geminiResponse.ok) {
          const detail = await geminiResponse.text();
          lastFailure = `${model} returned HTTP ${geminiResponse.status}`;
          console.error('[Gemini API Error]:', { model, status: geminiResponse.status, detail });
          continue;
        }
        const result = await geminiResponse.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const reply = result.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
        if (reply) {
          sendJson(response, 200, { reply, model });
          return;
        }
        lastFailure = `${model} returned an empty response.`;
      } catch (error) {
        lastFailure = `${model} request failed or timed out.`;
        console.error('[Gemini API Error]:', { model, error });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    sendJson(response, 200, {
      reply: localCopilotReply(message, context),
      degraded: true,
      degradedReason: lastFailure,
    });
  } catch (error) {
    console.error('[Gemini API Error]:', error);
    sendJson(response, 200, {
      reply: 'I could not parse that request. Ask about a section, train risk, conflict, or a P-Way/S&T/TRD bundling trade-off.',
      degraded: true,
    });
  }
}
