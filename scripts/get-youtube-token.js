#!/usr/bin/env node
/**
 * YouTube OAuth Refresh Token 발급 헬퍼
 *
 * 사용법:
 *   1) .env 에 YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 설정
 *      (Google Cloud Console → OAuth 2.0 클라이언트 ID = "데스크톱 앱")
 *      - YouTube Data API v3 활성화 필요
 *      - 승인된 리디렉션 URI에 http://localhost:8089/callback 추가
 *   2) node scripts/get-youtube-token.js 실행
 *   3) 콘솔에 출력되는 URL을 브라우저로 열고 구글 계정 동의
 *   4) 콘솔에 출력되는 refresh token을 .env 의 YOUTUBE_REFRESH_TOKEN 에 저장
 *
 * 의존성: googleapis (server 의존성과 공유)
 */
require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:8089/callback';
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const PORT = 8089;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 가 .env 에 설정되어 있지 않습니다.');
    process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',        // 매번 refresh_token 을 확실히 받기 위해
    scope: [SCOPE]
});

console.log('\n================ YouTube OAuth 토큰 발급 ================\n');
console.log('아래 URL을 브라우저에서 열어 구글 계정으로 동의하세요:\n');
console.log(authUrl + '\n');
console.log(`동의 후 http://localhost:${PORT}/callback 으로 자동 리디렉션되며, refresh token 이 출력됩니다.`);
console.log('(브라우저가 자동으로 열리지 않으면 위 URL을 직접 붙여넣으세요)\n');

const server = http.createServer(async (req, res) => {
    try {
        const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
        if (reqUrl.pathname !== '/callback') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        const code = reqUrl.searchParams.get('code');
        const err = reqUrl.searchParams.get('error');
        if (err) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h2>인증 실패: ${err}</h2>`);
            console.error('❌ 인증 실패:', err);
            server.close();
            process.exit(1);
        }
        if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('code 파라미터가 없습니다.');
            return;
        }

        const { tokens } = await oauth2Client.getToken(code);
        const refreshToken = tokens.refresh_token;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (refreshToken) {
            res.end('<h2>✅ 발급 완료</h2><p>터미널(콘솔)에 출력된 refresh token 을 .env 에 저장하세요. 이 창은 닫아도 됩니다.</p>');
            console.log('\n✅ Refresh Token 발급 성공! 아래 값을 .env 에 저장하세요:\n');
            console.log(`YOUTUBE_REFRESH_TOKEN=${refreshToken}\n`);
        } else {
            res.end('<h2>⚠ refresh token 이 반환되지 않았습니다.</h2><p>Google 계정의 앱 액세스 권한을 제거한 뒤 다시 시도하거나, prompt=consent 로 재시도하세요.</p>');
            console.warn('\n⚠ refresh token 이 반환되지 않았습니다. 이미 승인된 앱이라면 https://myaccount.google.com/permissions 에서 액세스 권한을 제거 후 다시 실행하세요.\n');
        }
        server.close();
        setTimeout(() => process.exit(0), 500);
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('토큰 교환 중 오류: ' + e.message);
        console.error('❌ 토큰 교환 오류:', e.message);
        server.close();
        process.exit(1);
    }
});

server.listen(PORT, () => {
    console.log(`콜백 대기 중... (http://localhost:${PORT}/callback)\n`);
});
