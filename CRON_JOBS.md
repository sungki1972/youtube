# 크론 작업 (Cron Jobs) 분석 및 가이드

## 📋 현재 프로젝트의 스케줄링 작업 현황

### ✅ 발견된 작업들

이 프로젝트에는 **실제 크론 작업(cron job)은 없습니다**. 다만 다음과 같은 일회성 지연 작업들이 있습니다:

#### 1. 백그라운드 작업 정리 (5분 후)
**위치**: `server.js:1146-1149`
```javascript
// 5분 후 진행상황 추적 정리
setTimeout(() => {
    progressTrackers.delete(jobId);
    backgroundJobs.delete(jobId);
}, 300000); // 5분
```
- **목적**: 완료된 MP3 추출 작업의 메모리 정리
- **타입**: 일회성 지연 실행 (반복 아님)

#### 2. 시은이 작업 정리 (5분 후)
**위치**: `server.js:2378-2380`
```javascript
// 작업 정리 (5분 후)
setTimeout(() => {
    sieunJobs.delete(jobId);
}, 300000);
```
- **목적**: 완료된 시은이 비디오 처리 작업의 메모리 정리
- **타입**: 일회성 지연 실행 (반복 아님)

#### 3. 재시도 지연 작업들
- Whisper API 재시도: `server.js:323, 466, 526`
- 번역 API 재시도: `server.js:620`
- FFmpeg 타임아웃: `server.js:172`

이들은 모두 **일회성 지연 실행**이며, 반복적인 크론 작업은 아닙니다.

---

## 🔄 크론 작업이 필요한 경우

다음과 같은 작업들을 자동화하려면 크론 작업이 필요할 수 있습니다:

### 1. 정기적인 파일 정리
- 오래된 임시 파일 삭제
- 업로드된 파일 중 오래된 것 정리

### 2. 데이터베이스 정리
- 오래된 작업 기록 삭제
- 로그 데이터 정리

### 3. 정기적인 백업
- Supabase 데이터 백업
- 업로드된 파일 백업

### 4. 정기적인 상태 확인
- 서버 헬스체크
- 외부 API 연결 확인

---

## 🛠️ 크론 작업 추가 방법

### 방법 1: node-cron 사용 (추천)

#### 설치
```bash
npm install node-cron
```

#### 사용 예시
```javascript
const cron = require('node-cron');

// 매일 자정에 실행
cron.schedule('0 0 * * *', () => {
    console.log('매일 자정에 실행되는 작업');
    // 임시 파일 정리
    cleanupTempFiles();
});

// 매시간 실행
cron.schedule('0 * * * *', () => {
    console.log('매시간 실행되는 작업');
    // 오래된 작업 기록 정리
    cleanupOldJobs();
});

// 매 30분마다 실행
cron.schedule('*/30 * * * *', () => {
    console.log('30분마다 실행되는 작업');
    // 서버 상태 확인
    checkServerHealth();
});
```

#### 크론 표현식 형식
```
* * * * * *
│ │ │ │ │ │
│ │ │ │ │ └─── 요일 (0-7, 0과 7은 일요일)
│ │ │ │ └───── 월 (1-12)
│ │ │ └─────── 일 (1-31)
│ │ └───────── 시 (0-23)
│ └─────────── 분 (0-59)
└───────────── 초 (0-59, 선택사항)
```

#### 일반적인 크론 표현식 예시
```javascript
'0 0 * * *'      // 매일 자정
'0 */6 * * *'    // 6시간마다
'*/30 * * * *'   // 30분마다
'0 9 * * 1'      // 매주 월요일 오전 9시
'0 0 1 * *'      // 매월 1일 자정
```

---

### 방법 2: node-schedule 사용

#### 설치
```bash
npm install node-schedule
```

#### 사용 예시
```javascript
const schedule = require('node-schedule');

// 매일 오전 9시에 실행
const job = schedule.scheduleJob('0 9 * * *', function(){
    console.log('매일 오전 9시에 실행');
});

// 특정 시간에 한 번만 실행
const date = new Date(2024, 11, 21, 5, 30, 0);
schedule.scheduleJob(date, function(){
    console.log('특정 날짜/시간에 실행');
});

// Cron 표현식 사용
schedule.scheduleJob('*/5 * * * *', function(){
    console.log('5분마다 실행');
});
```

---

### 방법 3: PM2의 Cron 기능 사용

PM2를 사용 중이라면 PM2의 내장 크론 기능을 사용할 수 있습니다.

#### PM2 Ecosystem 파일 생성 (`ecosystem.config.js`)
```javascript
module.exports = {
  apps: [
    {
      name: 'sermon-server',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork'
    },
    {
      name: 'cleanup-job',
      script: 'cron/cleanup.js',
      cron_restart: '0 0 * * *',  // 매일 자정
      autorestart: false
    }
  ]
};
```

#### 실행
```bash
pm2 start ecosystem.config.js
```

---

## 📝 추천 크론 작업 예시

### 1. 임시 파일 정리 작업

**파일**: `cron/cleanup-temp.js`
```javascript
const fs = require('fs');
const path = require('path');

async function cleanupTempFiles() {
    const tempDir = path.join(__dirname, '../uploads/temp');
    const maxAge = 24 * 60 * 60 * 1000; // 24시간
    
    try {
        const files = fs.readdirSync(tempDir);
        let deletedCount = 0;
        
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stats = fs.statSync(filePath);
            const age = Date.now() - stats.mtime.getTime();
            
            if (age > maxAge) {
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`삭제됨: ${file}`);
            }
        }
        
        console.log(`총 ${deletedCount}개의 임시 파일이 삭제되었습니다.`);
    } catch (error) {
        console.error('임시 파일 정리 오류:', error);
    }
}

cleanupTempFiles();
```

**server.js에 추가**:
```javascript
const cron = require('node-cron');

// 매일 새벽 3시에 임시 파일 정리
cron.schedule('0 3 * * *', async () => {
    console.log('[Cron] 임시 파일 정리 시작...');
    await cleanupTempFiles();
});
```

---

### 2. 오래된 작업 기록 정리

**server.js에 추가**:
```javascript
// 매일 자정에 오래된 작업 기록 정리
cron.schedule('0 0 * * *', () => {
    console.log('[Cron] 오래된 작업 기록 정리 시작...');
    
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7일
    
    // backgroundJobs 정리
    for (const [jobId, job] of backgroundJobs.entries()) {
        const age = now - job.startTime.getTime();
        if (age > maxAge && job.status === 'completed') {
            backgroundJobs.delete(jobId);
            progressTrackers.delete(jobId);
        }
    }
    
    // sieunJobs 정리
    for (const [jobId, job] of sieunJobs.entries()) {
        const age = now - job.startTime.getTime();
        if (age > maxAge && job.status === 'completed') {
            sieunJobs.delete(jobId);
        }
    }
    
    console.log('[Cron] 작업 기록 정리 완료');
});
```

---

### 3. 서버 헬스체크

**server.js에 추가**:
```javascript
// 매 5분마다 서버 상태 확인
cron.schedule('*/5 * * * *', async () => {
    console.log('[Cron] 서버 헬스체크 시작...');
    
    try {
        // Supabase 연결 확인
        const { data, error } = await supabase
            .from('youtube_summary')
            .select('count', { count: 'exact', head: true });
        
        if (error) {
            console.error('[Cron] Supabase 연결 오류:', error.message);
        } else {
            console.log('[Cron] 서버 상태 정상');
        }
    } catch (error) {
        console.error('[Cron] 헬스체크 오류:', error);
    }
});
```

---

## 🚀 크론 작업 추가 가이드

### 1단계: node-cron 설치
```bash
npm install node-cron
```

### 2단계: server.js에 크론 작업 추가
```javascript
// server.js 상단에 추가
const cron = require('node-cron');

// ... 기존 코드 ...

// 서버 시작 부분에 크론 작업 등록
app.listen(PORT, async () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    
    // 크론 작업 등록
    cron.schedule('0 0 * * *', () => {
        console.log('[Cron] 매일 자정 작업 실행');
        // 작업 내용
    });
    
    // ... 기존 코드 ...
});
```

### 3단계: PM2로 실행 시 크론 작업도 함께 실행
PM2를 사용 중이라면 크론 작업도 자동으로 실행됩니다.

---

## ⚠️ 주의사항

1. **메모리 누수 방지**: 크론 작업에서 사용하는 리소스는 적절히 정리해야 합니다.

2. **에러 처리**: 크론 작업 내부에서 발생하는 에러는 적절히 처리해야 합니다.
   ```javascript
   cron.schedule('0 0 * * *', async () => {
       try {
           // 작업 내용
       } catch (error) {
           console.error('[Cron] 작업 실행 오류:', error);
       }
   });
   ```

3. **성능 고려**: 크론 작업이 서버 성능에 영향을 주지 않도록 주의해야 합니다.

4. **로깅**: 크론 작업의 실행 여부와 결과를 로그로 남기는 것이 좋습니다.

---

## 📊 현재 프로젝트에 권장하는 크론 작업

1. **임시 파일 정리** (매일 새벽 3시)
   - `uploads/temp/` 폴더의 오래된 파일 삭제

2. **작업 기록 정리** (매일 자정)
   - 완료된 작업 기록 메모리에서 제거

3. **서버 헬스체크** (매 5분)
   - Supabase 연결 상태 확인
   - 디스크 공간 확인

4. **로그 파일 정리** (매주 일요일)
   - 오래된 로그 파일 압축 또는 삭제

---

## 🔍 크론 작업 확인 방법

### PM2 사용 시
```bash
# PM2 로그에서 크론 작업 확인
pm2 logs sermon-server | grep "Cron"
```

### 직접 확인
```bash
# 서버 로그 파일 확인
tail -f server.log | grep "Cron"
```

---

## 📚 참고 자료

- [node-cron 문서](https://github.com/node-cron/node-cron)
- [node-schedule 문서](https://github.com/node-schedule/node-schedule)
- [PM2 Cron 기능](https://pm2.keymetrics.io/docs/usage/cron-jobs/)

