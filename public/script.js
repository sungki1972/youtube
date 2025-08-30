// 전역 변수
let currentPage = 1;
let isEditing = false;
let currentSermonId = null;

// DOM 로드 완료 후 실행
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

// 앱 초기화
function initializeApp() {
    setupTabNavigation();
    setupEventListeners();
    loadSermons();
    feather.replace();
}

// 탭 네비게이션 설정
function setupTabNavigation() {
    const tab1 = document.getElementById('tab1');
    const tab2 = document.getElementById('tab2');
    const tab1Content = document.getElementById('tab1-content');
    const tab2Content = document.getElementById('tab2-content');

    tab1.addEventListener('click', () => switchTab(tab1, tab1Content, tab2, tab2Content));
    tab2.addEventListener('click', () => switchTab(tab2, tab2Content, tab1, tab1Content));
}

// 탭 전환
function switchTab(activeTab, activeContent, inactiveTab, inactiveContent) {
    activeTab.classList.add('border-blue-500', 'text-blue-600');
    activeTab.classList.remove('border-transparent', 'text-gray-500');
    activeContent.classList.remove('hidden');

    inactiveTab.classList.remove('border-blue-500', 'text-blue-600');
    inactiveTab.classList.add('border-transparent', 'text-gray-500');
    inactiveContent.classList.add('hidden');
}

// 이벤트 리스너 설정
function setupEventListeners() {
    // MP3 추출 폼
    document.getElementById('extractForm').addEventListener('submit', handleExtractSubmit);
    
    // 설교 추가 버튼
    document.getElementById('addSermonBtn').addEventListener('click', showAddSermonModal);
    
    // 모달 관련
    document.getElementById('cancelBtn').addEventListener('click', hideModal);
    document.getElementById('sermonForm').addEventListener('submit', handleSermonSubmit);
}

// MP3 추출 제출 처리
async function handleExtractSubmit(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const data = {
        youtubeUrl: formData.get('youtubeUrl'),
        startTime: formData.get('startTime'),
        endTime: formData.get('endTime'),
        title: formData.get('title') || 'sermon'
    };

    // 시간 형식 검증
    if (!isValidTimeFormat(data.startTime) || !isValidTimeFormat(data.endTime)) {
        alert('시간 형식이 올바르지 않습니다. HH:MM:SS 형식으로 입력해주세요.');
        return;
    }

    const statusDiv = document.getElementById('extractStatus');
    statusDiv.textContent = 'MP3 추출 중... 잠시만 기다려주세요.';

    try {
        const response = await fetch('/api/extract-mp3', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (result.success) {
            showExtractResult(result);
            statusDiv.textContent = '추출 완료!';
        } else {
            statusDiv.textContent = `오류: ${result.error}`;
        }
    } catch (error) {
        console.error('Error:', error);
        statusDiv.textContent = '서버 오류가 발생했습니다.';
    }
}

// 시간 형식 검증
function isValidTimeFormat(time) {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
    return timeRegex.test(time);
}

// 추출 결과 표시
function showExtractResult(result) {
    document.getElementById('resultMessage').textContent = result.message;
    document.getElementById('resultFileName').textContent = `파일명: ${result.fileName}`;
    document.getElementById('extractResult').classList.remove('hidden');
}

// 설교 목록 로드
async function loadSermons(page = 1) {
    try {
        const response = await fetch(`/api/sermons?page=${page}`);
        const data = await response.json();

        if (data.sermons) {
            renderSermonTable(data.sermons);
            renderPagination(data.pagination);
            currentPage = page;
        }
    } catch (error) {
        console.error('Error loading sermons:', error);
    }
}

// 설교 테이블 렌더링
function renderSermonTable(sermons) {
    const tbody = document.getElementById('sermonTableBody');
    tbody.innerHTML = '';

    if (sermons.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="px-6 py-4 text-center text-gray-500">
                    등록된 설교가 없습니다.
                </td>
            </tr>
        `;
        return;
    }

    sermons.forEach(sermon => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${formatDate(sermon.date)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${sermon.title}</td>
            <td class="px-6 py-4 text-sm text-gray-900">
                <button onclick="copyText('${sermon.txt_file}')" 
                    class="text-blue-600 hover:text-blue-900 font-medium">
                    텍스트 복사
                </button>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                <button onclick="playMp3('${sermon.mp3_file}')" 
                    class="text-green-600 hover:text-green-900 font-medium">
                    MP3 재생
                </button>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium">
                <button onclick="editSermon(${sermon.id})" 
                    class="text-indigo-600 hover:text-indigo-900 mr-3">
                    수정
                </button>
                <button onclick="deleteSermon(${sermon.id})" 
                    class="text-red-600 hover:text-red-900">
                    삭제
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// 페이지네이션 렌더링
function renderPagination(pagination) {
    const paginationDiv = document.getElementById('pagination');
    
    if (pagination.totalPages <= 1) {
        paginationDiv.innerHTML = '';
        return;
    }

    let paginationHTML = '<div class="flex items-center justify-between">';
    paginationHTML += '<div class="flex-1 flex justify-between sm:hidden">';
    
    if (pagination.currentPage > 1) {
        paginationHTML += `<button onclick="loadSermons(${pagination.currentPage - 1})" class="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">이전</button>`;
    }
    
    if (pagination.currentPage < pagination.totalPages) {
        paginationHTML += `<button onclick="loadSermons(${pagination.currentPage + 1})" class="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">다음</button>`;
    }
    
    paginationHTML += '</div>';
    paginationHTML += '<div class="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">';
    paginationHTML += `<div class="text-sm text-gray-700">총 <span class="font-medium">${pagination.totalItems}</span>개 중 <span class="font-medium">${(pagination.currentPage - 1) * pagination.itemsPerPage + 1}</span> - <span class="font-medium">${Math.min(pagination.currentPage * pagination.itemsPerPage, pagination.totalItems)}</span></div>`;
    paginationHTML += '<div>';
    paginationHTML += '<nav class="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">';
    
    // 페이지 번호들
    for (let i = 1; i <= pagination.totalPages; i++) {
        if (i === pagination.currentPage) {
            paginationHTML += `<span class="relative inline-flex items-center px-4 py-2 border border-blue-500 bg-blue-50 text-sm font-medium text-blue-600">${i}</span>`;
        } else {
            paginationHTML += `<button onclick="loadSermons(${i})" class="relative inline-flex items-center px-4 py-2 border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50">${i}</button>`;
        }
    }
    
    paginationHTML += '</nav></div></div></div>';
    
    paginationDiv.innerHTML = paginationHTML;
}

// 날짜 포맷팅
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('ko-KR');
}

// 텍스트 복사
async function copyText(txtFileUrl) {
    try {
        const response = await fetch(txtFileUrl);
        const text = await response.text();
        
        await navigator.clipboard.writeText(text);
        alert('텍스트가 클립보드에 복사되었습니다.');
    } catch (error) {
        console.error('Error copying text:', error);
        alert('텍스트 복사 중 오류가 발생했습니다.');
    }
}

// MP3 재생
function playMp3(mp3FileUrl) {
    const audio = new Audio(mp3FileUrl);
    audio.play().catch(error => {
        console.error('Error playing audio:', error);
        alert('MP3 재생 중 오류가 발생했습니다.');
    });
}

// 설교 추가 모달 표시
function showAddSermonModal() {
    isEditing = false;
    currentSermonId = null;
    document.getElementById('modalTitle').textContent = '설교 추가';
    document.getElementById('sermonForm').reset();
    document.getElementById('sermonModal').classList.remove('hidden');
}

// 설교 수정 모달 표시
async function editSermon(id) {
    try {
        const response = await fetch(`/api/sermons/${id}`);
        const data = await response.json();
        
        if (data.sermon) {
            isEditing = true;
            currentSermonId = id;
            document.getElementById('modalTitle').textContent = '설교 수정';
            document.getElementById('modalTitleInput').value = data.sermon.title;
            document.getElementById('modalDate').value = data.sermon.date;
            document.getElementById('modalMp3File').value = data.sermon.mp3_file;
            document.getElementById('modalTxtFile').value = data.sermon.txt_file;
            document.getElementById('sermonModal').classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error loading sermon:', error);
        alert('설교 정보를 불러오는 중 오류가 발생했습니다.');
    }
}

// 모달 숨기기
function hideModal() {
    document.getElementById('sermonModal').classList.add('hidden');
}

// 설교 폼 제출 처리
async function handleSermonSubmit(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const data = {
        title: formData.get('modalTitle'),
        date: formData.get('modalDate'),
        mp3File: formData.get('modalMp3File'),
        txtFile: formData.get('modalTxtFile')
    };

    try {
        const url = isEditing ? `/api/sermons/${currentSermonId}` : '/api/sermons';
        const method = isEditing ? 'PUT' : 'POST';
        
        const response = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (result.success) {
            hideModal();
            loadSermons(currentPage);
            alert(isEditing ? '설교가 수정되었습니다.' : '설교가 추가되었습니다.');
        } else {
            alert(`오류: ${result.error}`);
        }
    } catch (error) {
        console.error('Error saving sermon:', error);
        alert('설교 저장 중 오류가 발생했습니다.');
    }
}

// 설교 삭제
async function deleteSermon(id) {
    if (!confirm('정말로 이 설교를 삭제하시겠습니까?')) {
        return;
    }

    try {
        const response = await fetch(`/api/sermons/${id}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (result.success) {
            loadSermons(currentPage);
            alert('설교가 삭제되었습니다.');
        } else {
            alert(`오류: ${result.error}`);
        }
    } catch (error) {
        console.error('Error deleting sermon:', error);
        alert('설교 삭제 중 오류가 발생했습니다.');
    }
} 