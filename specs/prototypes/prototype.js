function initPrototype() {
    if (window.lucide) {
        window.lucide.createIcons();
    }

    document.querySelectorAll('[data-state-target]').forEach(button => {
        button.addEventListener('click', () => {
            const targetId = button.getAttribute('data-state-target');
            const state = button.getAttribute('data-state');
            const target = targetId ? document.getElementById(targetId) : null;
            if (!target || !state) return;

            target.setAttribute('data-demo-state', state);
            document.querySelectorAll(`[data-state-target="${targetId}"]`).forEach(peer => {
                peer.classList.toggle('active', peer === button);
            });
        });
    });
}

window.addEventListener('DOMContentLoaded', initPrototype);
