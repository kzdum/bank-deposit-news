require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const client = new Anthropic(); // uses ANTHROPIC_API_KEY env var

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'news.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Claude API call with web search ────────────────────────────────────────

async function fetchAndSummarizeNews() {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${now}] 요구불 예금 뉴스 수집 시작...`);

  const userPrompt = `웹 검색 도구를 사용하여 오늘 기준 최근 24시간 이내에 발행된 한국의 "요구불 예금" 관련 뉴스 기사를 최대한 많이 찾아주세요.

검색 초점:
- 한국 주요 시중은행(KB국민, 신한, 하나, 우리, NH농협 등)의 요구불 예금 잔액 현황
- 요구불 예금 증감 규모 및 추이
- 관련 금융 시장 동향 및 분석

검색 완료 후 아래 JSON 형식으로만 응답해주세요. JSON 외 다른 텍스트는 포함하지 마세요.

{
  "articles": [
    {
      "title": "기사 제목",
      "summary": "핵심 내용 요약 (2~3문장, 구체적인 수치 포함)",
      "source": "언론사명",
      "url": "기사 URL",
      "publishedAt": "발행 시간"
    }
  ],
  "overallSummary": "요구불 예금 전반적 동향 종합 요약 (3~5문장, 주요 수치·변동 요인 포함)"
}

24시간 이내 기사가 없으면 articles를 빈 배열로 두고 overallSummary에 그 이유를 작성해주세요.`;

  try {
    let messages = [{ role: 'user', content: userPrompt }];
    let response;
    let iterations = 0;
    const maxIterations = 5;

    while (iterations < maxIterations) {
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        messages,
      });

      if (response.stop_reason === 'end_turn') break;

      // Server-side loop hit its limit — re-send to continue
      if (response.stop_reason === 'pause_turn') {
        messages = [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: response.content },
        ];
        iterations++;
        continue;
      }

      break;
    }

    // Extract text from response
    let textContent = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    // Parse JSON from Claude's response
    let newsData = { articles: [], overallSummary: textContent };
    try {
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.articles !== undefined) {
          newsData = parsed;
        }
      }
    } catch (parseErr) {
      console.error('JSON 파싱 오류:', parseErr.message);
    }

    const result = {
      articles: newsData.articles || [],
      overallSummary: newsData.overallSummary || '',
      updatedAt: new Date().toISOString(),
      status: 'success',
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[${now}] 완료 — 기사 ${result.articles.length}건 저장`);
    return result;
  } catch (err) {
    console.error('뉴스 수집 오류:', err.message);
    const errorResult = {
      articles: [],
      overallSummary: `뉴스를 가져오는 중 오류가 발생했습니다: ${err.message}`,
      updatedAt: new Date().toISOString(),
      status: 'error',
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(errorResult, null, 2), 'utf8');
    return errorResult;
  }
}

// ─── Express routes ──────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Return cached news data
app.get('/api/news', (req, res) => {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return res.json(data);
    } catch {
      /* fall through */
    }
  }
  res.json({
    articles: [],
    overallSummary: '아직 데이터가 없습니다. 잠시 후 새로고침 해주세요.',
    updatedAt: null,
    status: 'no_data',
  });
});

// Manual refresh endpoint
app.post('/api/refresh', async (req, res) => {
  const result = await fetchAndSummarizeNews();
  res.json(result);
});

// ─── Cron scheduler: 매일 오전 6시 30분 KST ──────────────────────────────────

cron.schedule('30 6 * * *', fetchAndSummarizeNews, {
  timezone: 'Asia/Seoul',
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
  console.log('스케줄: 매일 오전 6:30 (KST) 자동 수집');

  // Initial fetch if no cached data exists
  if (!fs.existsSync(DATA_FILE)) {
    console.log('초기 데이터 없음 — 첫 수집 시작...');
    fetchAndSummarizeNews();
  }
});
