# UN 기구 공개 채용

「국제관계와 국제기구」 4. 국제연맹과 국제연합, 2~3차시용 **개인 활동** 웹 페이지입니다. Zoom 실시간 쌍방향 수업을 기준으로 만들었습니다.

- 학생 화면: https://created412.github.io/un-recruit/
- 교사용 기록 보기: https://created412.github.io/un-recruit/teacher.html

## 수업 흐름

- **2차시 서류 전형**: UN 기구 한 곳을 골라 조사하고 지원서(5문항)를 씁니다.
- **3차시 현장 미션**: 지원한 기구의 신입 직원이 되어 네 가지 위기(거부권, 주권의 벽, 재정 위기, 강대국의 이탈)를 판단하고 근거를 씁니다. 미션마다 국제연맹의 역사와 연결한 ‘역사의 거울’이 나옵니다.
- **마무리**: 판단 성향이 담긴 임명장을 받고, 성찰 두 문항을 써서 최종 제출합니다.

분 단위 진행표와 채점 기준은 학생 화면 맨 아래 「교사용 진행 안내」에 있습니다.

## 학생 기록

- 학생은 학번, 이름, PIN 숫자 4자리로 시작합니다. 쓰는 내용은 몇 초마다 기록 저장소에 자동 저장되고, 다른 기기에서도 같은 학번, 이름, PIN으로 이어서 합니다.
- 교사는 `teacher.html`에서 교사 비밀번호로 반 전체 진행 단계, 미션 진행, 마지막 저장 시각, 학생별 글을 봅니다. 30초마다 새로 고쳐지고, CSV로 내려받을 수 있습니다.
- 학생이 PIN을 잊으면 교사용 기록 보기에서 그 학생을 누르고 **PIN 초기화**를 누릅니다.

## 구성

| 파일 | 내용 |
|---|---|
| `index.html` | 학생 화면 |
| `teacher.html` | 교사용 기록 보기 |
| `config.js` | 기록 저장소 주소 |
| `img/` | 삽화 18장 (Higgsfield, GPT Image 2.5로 생성) |
| `worker/` | 기록 저장소 API (Cloudflare Worker + D1 데이터베이스 `un-recruit-db`) |

### 기록 저장소 관리 (Cloudflare)

```bash
cd worker
npx wrangler deploy                          # 코드 수정 후 다시 배포
npx wrangler secret put TEACHER_KEY          # 교사 비밀번호 바꾸기
npx wrangler d1 execute un-recruit-db --remote --command "SELECT sid, name, stage, saved_at FROM records"
npx wrangler d1 export un-recruit-db --remote --output=backup.sql   # 전체 백업
```

## 고칠 수 있는 곳

- 기구 목록: `index.html`의 `ORGS`
- 미션 내용, 선택지, 게이지 변화: `index.html`의 `MISSIONS`
- 글자 수 기준: 각 입력 칸의 `data-min`
