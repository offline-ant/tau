;;; emacs-share.el --- Drive a disposable Emacs for the pimux three-way test -*- lexical-binding: t; -*-

;;; Commentary:

;; Loaded into a disposable daemon on the real configuration by
;; emacs-share.e2e.ts.  Every function answers through `es-reply': base64 JSON,
;; because emacsclient prints Lisp, not JSON.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'pi-deck)

;; A disposable daemon must not play sounds on the operator's shared devices.
(when (fboundp 'pi-sound-deck-notify)
  (remove-hook 'pi-deck-notify-functions #'pi-sound-deck-notify))
(setq pi-deck-notify-method nil)

(defvar es-chats nil "Alist of test name to chat buffer.")
(defvar es-records nil "Pimux record types Pilish handled, newest first.")

(advice-add 'pilish--shared-handle-record :before
            (lambda (event) (push (plist-get event :type) es-records)))

(defun es-reply (value)
  "Encode VALUE, a plist or vector, for the test."
  (base64-encode-string (encode-coding-string (json-encode value) 'utf-8) t))

(defun es--chat (name)
  "Return the chat buffer of test agent NAME."
  (or (alist-get name es-chats nil nil #'equal) (error "No test agent %s" name)))

(defun es-start (project name)
  "Start pi-deck agent NAME in a space for PROJECT; return its identity."
  (let ((space (file-name-nondirectory (directory-file-name project))))
    (unless (member space (pi-deck-space-names))
      (pi-deck-create-space project space))
    (pi-deck-select-space space))
  (let ((chat (pi-deck-agent-buffer (pi-deck-new-agent name)))
        (deadline (+ (float-time) 60)))
    (setf (alist-get name es-chats nil nil #'equal) chat)
    (while (and (< (float-time) deadline)
                (not (and (pilish-session-file chat) (pilish-session-mux chat))))
      (accept-process-output nil 0.05))
    (es-reply (list :buffer (buffer-name chat)
                    :file (pilish-session-file chat)
                    :muxId (plist-get (pilish-session-mux chat) :muxId)))))

(defun es--dialog-widgets (chat)
  "Return the dialog ids that have a widget in CHAT."
  (with-current-buffer chat
    (let (ids (pos (point-min)))
      (while (setq pos (next-single-property-change pos 'pilish-dialog))
        (when-let* ((id (get-text-property pos 'pilish-dialog)))
          (cl-pushnew id ids :test #'equal)))
      (vconcat ids))))

(defun es-state (name)
  "Return the observable state of agent NAME."
  (let* ((chat (es--chat name))
         (agent (pi-deck-agent chat))
         (process (pilish-session-process chat))
         (model (pilish-session-model chat)))
    (es-reply
     (list :pid (and (process-live-p process) (process-id process))
           :buffer (buffer-name chat)
           :file (pilish-session-file chat)
           :dir (pilish-session-directory chat)
           :model (and model (format "%s/%s" (plist-get model :provider) (plist-get model :id)))
           :status (symbol-name (buffer-local-value 'pilish--status chat))
           :deck (and agent (symbol-name (pi-deck-agent-state agent)))
           :deckFile (and agent (pi-deck-agent-session-file agent))
           :dialogs (vconcat (mapcar (lambda (r) (plist-get r :id))
                                     (pilish-session-pending-dialogs chat)))
           :widgets (es--dialog-widgets chat)
           :draft (with-current-buffer (pilish-session-input-buffer chat) (buffer-string))
           :records (vconcat (reverse es-records))))))

(defun es-count (name text)
  "Return how often TEXT occurs in agent NAME's chat."
  (with-current-buffer (es--chat name)
    (save-excursion
      (goto-char (point-min))
      (let ((n 0))
        (while (search-forward text nil t) (setq n (1+ n)))
        (es-reply (list :count n))))))

(defun es-send (name text)
  "Type TEXT into agent NAME's input and send it as a user would."
  (with-current-buffer (pilish-session-input-buffer (es--chat name))
    (erase-buffer)
    (insert text)
    (pilish-send))
  (es-reply (list :sent t)))

(defun es-draft (name text)
  "Leave TEXT as agent NAME's draft."
  (with-current-buffer (pilish-session-input-buffer (es--chat name))
    (erase-buffer)
    (insert text))
  (es-reply (list :draft t)))

(defun es-answer (name value)
  "Answer agent NAME's oldest dialog with VALUE."
  (let* ((chat (es--chat name))
         (process (pilish-session-process chat))
         (request (car (pilish-session-pending-dialogs chat))))
    (unless request (error "No pending dialog"))
    (pilish--extension-dialog-respond process request (list :value value))
    (es-reply (list :answered (plist-get request :id)))))

(defun es-select-model (name spec)
  "Choose the model containing SPEC in agent NAME through Pilish's command."
  (with-current-buffer (es--chat name)
    (cl-letf (((symbol-function 'completing-read)
               (lambda (_prompt collection &rest _)
                 (seq-find (lambda (candidate) (string-search spec candidate))
                           (if (functionp collection)
                               (funcall collection "" nil t)
                             (mapcar (lambda (entry) (if (consp entry) (car entry) entry))
                                     collection))))))
      (pilish-select-model)))
  (es-reply (list :selected spec)))

(defun es-stall (seconds)
  "Keep Emacs from reading anything for SECONDS."
  (let ((end (+ (float-time) seconds)))
    (while (< (float-time) end)))
  (es-reply (list :stalled seconds)))

(defun es-minibuffer ()
  "Report whether a minibuffer is open."
  (es-reply (list :open (and (active-minibuffer-window) t))))

(defun es-deck ()
  "Report pi-deck's agents: buffer name, state, worker flag."
  (es-reply
   (vconcat
    (mapcar (lambda (agent)
              (list :buffer (buffer-name (pi-deck-agent-buffer agent))
                    :state (symbol-name (pi-deck-agent-state agent))
                    :worker (and (pi-deck-agent-worker-p agent) t)))
            (pi-deck-agents)))))

(defun es-worker (parent)
  "Return the worker chat of agent PARENT, registering it as a test agent."
  (let ((worker (seq-find (lambda (target)
                            (and (equal (plist-get target :kind) "pi")
                                 (eq (plist-get target :parent) (es--chat parent))))
                          (pi-orchestration-targets))))
    (when worker
      (setf (alist-get "worker" es-chats nil nil #'equal) (plist-get worker :buffer)))
    (es-reply (list :buffer (and worker (buffer-name (plist-get worker :buffer)))))))

(defun es-stop (name)
  "Stop agent NAME as pi-deck's sidebar does."
  (pi-deck-stop-agent (pi-deck-agent (es--chat name)))
  (es-reply (list :stopped t)))

(defun es-alive (name)
  "Report whether agent NAME's process lives."
  (let ((chat (alist-get name es-chats nil nil #'equal)))
    (es-reply (list :alive (and chat (buffer-live-p chat)
                                (process-live-p (pilish-session-process chat))
                                t)))))

(provide 'emacs-share)
;;; emacs-share.el ends here
