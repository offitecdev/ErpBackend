import { Router } from 'express';
import { BookingController } from '../controllers/BookingController';
import { GetAvailableAppointmentsUseCase } from '../../application/use-cases/project/GetAvailableAppointmentsUseCase';
import { BookAppointmentUseCase } from '../../application/use-cases/project/BookAppointmentUseCase';
import { AppointmentRepository } from '../../infrastructure/repositories/AppointmentRepository';
import { ProjectRepository } from '../../infrastructure/repositories/ProjectRepository';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { rateLimit } from '../middlewares/RateLimitMiddleware';

// These two endpoints are public by design (customer books via an emailed
// per-project token, no account). Rate-limited so tokens can't be brute-forced.
const publicBookingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
});

const router = Router();
const appointmentRepo = new AppointmentRepository();
const projectRepo = new ProjectRepository();
const bookingController = new BookingController(
    new GetAvailableAppointmentsUseCase(appointmentRepo, projectRepo),
    new BookAppointmentUseCase(appointmentRepo, projectRepo),
    appointmentRepo
);

router.get('/slots', publicBookingLimiter, (req, res) => bookingController.getAvailableSlots(req, res));
router.post('/book', publicBookingLimiter, (req, res) => bookingController.bookSlot(req, res));
router.post('/slots', requireAuth, requirePermission('projects.bookings.manage'), (req, res) => bookingController.createAdminSlots(req, res));

export default router;
