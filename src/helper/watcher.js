import os from 'os'
import { pollForTask, ackTask, updateTask } from './connector'

const DEFAULT_OPTIONS = {
  pollingIntervals: 1000,
  baseURL: 'http://localhost:8080/api',
  maxRunner: 1,
  autoAck: true,
  workerID: os.hostname()
}

const TASK_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  FAILED: 'FAILED',
  COMPLETED: 'COMPLETED'
}

export default class Watcher {
  isPolling = false
  tasks = {}
  tasksTimeout = {}

  constructor(taskType, options, callback, errorCallback = f => f) {
    if (!callback) throw new Error('Callback function is required')
    this.taskType = taskType
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.callback = callback
    this.errorCallback = errorCallback
  }

  destroyTaskTimeout = taskId => {
    clearTimeout(this.tasksTimeout[taskId])
    delete this.tasks[taskId]
  }

  destroyTask = taskId => delete this.tasks[taskId]

  ackTask = taskId => ackTask(this.options.baseURL, taskId, this.options.workerID)

  updateResult = async ({
    workflowInstanceId,
    taskId,
    reasonForIncompletion,
    status,
    outputData = {},
    ...extraTaskData
  }) => {
    try {
      const result = updateTask(this.options.baseURL, {
        workflowInstanceId,
        taskId,
        reasonForIncompletion,
        status,
        outputData,
        ...extraTaskData
      })
      // if ([TASK_STATUS.IN_PROGRESS, TASK_STATUS.FAILED, TASK_STATUS.COMPLETED].includes(status)) {
      //   this.destroyTaskTimeout(taskId)
      //   this.destroyTask(taskId)
      // }
      return result
    } catch (error) {
      throw error
    }
  }

  // this should be private function
  polling = async () => {
    this.startTime = new Date()
    try {
      const { baseURL, workerID } = this.options
      const { data } = await pollForTask(baseURL, this.taskType, workerID)
      if (data) {
        this.tasks[data.taskId] = data
        if (this.options.autoAck === true) await this.ackTask(data.taskId)

        if (data.responseTimeoutSeconds > 0) {
          this.tasksTimeout[data.taskId] = setTimeout(() => {
            this.destroyTask(data.taskId)
            this.errorCallback(new Error(`Task "${data.taskId}" is not update in time`))
          }, data.responseTimeoutSeconds * 1000)
        }
        try {
          const callbackUpdater = ({
            status,
            outputData,
            reasonForIncompletion = '',
            ...extraTaskData
          }) =>
            this.updateResult({
              workflowInstanceId: data.workflowInstanceId,
              taskId: data.taskId,
              reasonForIncompletion,
              status,
              outputData,
              ...extraTaskData
            })

          callbackUpdater.complete = ({
            outputData,
            reasonForIncompletion = '',
            ...extraTaskData
          }) =>
            this.updateResult({
              workflowInstanceId: data.workflowInstanceId,
              taskId: data.taskId,
              reasonForIncompletion,
              status: TASK_STATUS.COMPLETED,
              outputData,
              ...extraTaskData
            })

          callbackUpdater.fail = ({ outputData, reasonForIncompletion = '', ...extraTaskData }) =>
            this.updateResult({
              workflowInstanceId: data.workflowInstanceId,
              taskId: data.taskId,
              reasonForIncompletion,
              status: TASK_STATUS.FAILED,
              outputData,
              ...extraTaskData
            })
          callbackUpdater.inprogress = ({
            outputData,
            reasonForIncompletion = '',
            ...extraTaskData
          }) =>
            this.updateResult({
              workflowInstanceId: data.workflowInstanceId,
              taskId: data.taskId,
              reasonForIncompletion,
              status: TASK_STATUS.IN_PROGRESS,
              outputData,
              ...extraTaskData
            })

          await this.callback(data, callbackUpdater)
        } catch (error) {
          this.updateResult({
            workflowInstanceId: data.workflowInstanceId,
            taskId: data.taskId,
            reasonForIncompletion: error.message,
            status: TASK_STATUS.FAILED
          })
        } finally {
          this.destroyTaskTimeout(data.taskId)
          this.destroyTask(data.taskId)
        }
      }
    } catch (error) {
      this.errorCallback(error)
    } finally {
      setTimeout(this.polling, this.options.pollingIntervals - (new Date() - this.startTime))
    }
  }

  startPolling = () => {
    if (this.isPolling) throw new Error('Watcher is already started')
    this.isPolling = true
    this.startTime = new Date()
    for (let i = 0; i < this.options.maxRunner; i++) {
      this.polling(i)
    }
  }
}
